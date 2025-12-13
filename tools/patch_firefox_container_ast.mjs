#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function getColumnAt(text, index, eol) {
  const nl = eol === '\r\n'
    ? text.lastIndexOf('\r\n', index - 1)
    : text.lastIndexOf('\n', index - 1);
  return index - (nl < 0 ? 0 : nl + eol.length);
}

function indentLines(text, indent) {
  const pad = ' '.repeat(indent);
  return text
    .split('\n')
    .map(line => pad + line)
    .join('\n');
}

function applyEdits(text, edits) {
  // Apply from back to front to keep offsets stable.
  const sorted = edits
    .slice()
    .sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

function loadBabel(upstreamRoot) {
  const requireFromUpstream = createRequire(path.join(upstreamRoot, 'package.json'));
  const babel = requireFromUpstream('@babel/core');
  return { babel };
}

function parseJs(babel, code) {
  return babel.parseSync(code, {
    sourceType: 'module',
    parserOpts: {
      ranges: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: [
        'functionBind',
        'dynamicImport',
        'topLevelAwait',
        'optionalChaining',
        'nullishCoalescingOperator',
        'objectRestSpread',
        'classProperties',
        'logicalAssignment',
        'numericSeparator',
      ],
    },
  });
}

function parseTs(babel, code) {
  return babel.parseSync(code, {
    sourceType: 'module',
    parserOpts: {
      ranges: true,
      plugins: ['typescript'],
    },
  });
}

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return false;
  if (visitor(node, parent) === false) return true; // stop signal
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (walk(item, visitor, node)) return true;
      }
    } else if (typeof val === 'object') {
      if (walk(val, visitor, node)) return true;
    }
  }
  return false;
}

function findFirst(root, predicate) {
  let found;
  walk(root, (n, p) => {
    if (predicate(n, p)) {
      found = n;
      return false;
    }
    return undefined;
  });
  return found;
}

async function patchPreinject({ upstreamRoot, babel }) {
  const file = path.join(upstreamRoot, 'src', 'background', 'utils', 'preinject.js');
  const code = await fs.readFile(file, 'utf8');
  if (code.includes('const container = IS_FIREFOX && tab.cookieStoreId;')) {
    return false;
  }
  const eol = detectEol(code);
  const ast = parseJs(babel, code);

  let targetMethod;
  walk(ast, (n) => {
    if (n.type === 'ObjectMethod') {
      const k = n.key;
      if (k && k.type === 'Identifier' && k.name === 'GetInjected') {
        targetMethod = n;
        return false;
      }
    }
    return undefined;
  });
  if (!targetMethod) {
    throw new PatchError('preinject.js: cannot find ObjectMethod GetInjected');
  }

  const body = targetMethod.body.body;
  const returnStmt = body
    .filter(s => s.type === 'ReturnStatement' && s.argument && s.argument.type === 'ConditionalExpression')
    .find(s => s.argument.test.type === 'Identifier' && s.argument.test.name === 'isApplied');
  if (!returnStmt) {
    throw new PatchError('preinject.js: cannot find return statement "return isApplied ? ..." in GetInjected');
  }

  const indent = getColumnAt(code, returnStmt.start, eol);

  const snippet = [
    'const container = IS_FIREFOX && tab.cookieStoreId;',
    'const injectInfo = inject.info || {};',
    'const injectGmi = injectInfo.gmi || {};',
    'const injectOut = container',
    '  ? {',
    '    __proto__: null,',
    '    ...inject,',
    '    info: {',
    '      __proto__: null,',
    '      ...injectInfo,',
    '      gmi: { __proto__: null, ...injectGmi, container },',
    '    },',
    '  }',
    '  : inject;',
  ].join('\n');

  const insertText = indentLines(snippet, indent).replaceAll('\n', eol) + eol;

  const retText = code.slice(returnStmt.start, returnStmt.end);
  const patchedRetText = retText.replace(/\binject\b/g, 'injectOut');

  const out = applyEdits(code, [
    { start: returnStmt.start, end: returnStmt.start, replacement: insertText },
    { start: returnStmt.start, end: returnStmt.end, replacement: patchedRetText },
  ]);
  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function patchInject({ upstreamRoot, babel }) {
  const file = path.join(upstreamRoot, 'src', 'injected', 'content', 'inject.js');
  const code = await fs.readFile(file, 'utf8');
  if (code.includes('info.gmi = assign(info.gmi || createNullObj(),')) {
    return false;
  }
  const eol = detectEol(code);
  const ast = parseJs(babel, code);

  const injectScriptsFn = findFirst(ast, n => (
    n.type === 'FunctionDeclaration'
    && n.id?.type === 'Identifier'
    && n.id.name === 'injectScripts'
  ));
  if (!injectScriptsFn) {
    throw new PatchError('inject.js: cannot find function injectScripts');
  }

  const assignExpr = findFirst(injectScriptsFn, n => {
    if (n.type !== 'AssignmentExpression') return false;
    if (n.operator !== '=') return false;
    const l = n.left;
    if (l.type !== 'MemberExpression') return false;
    if (l.object.type !== 'Identifier' || l.object.name !== 'info') return false;
    const prop = l.property;
    const propName = prop.type === 'Identifier' ? prop.name : null;
    if (propName !== 'gmi') return false;
    if (n.right.type === 'CallExpression'
      && n.right.callee.type === 'Identifier'
      && n.right.callee.name === 'assign') return false;
    if (n.right.type !== 'ObjectExpression') return false;
    return true;
  });

  if (!assignExpr) {
    throw new PatchError('inject.js: cannot find assignment "info.gmi = { ... }" in injectScripts');
  }

  const objText = code.slice(assignExpr.right.start, assignExpr.right.end);
  const replacement = `assign(info.gmi || createNullObj(), ${objText})`;

  const out = applyEdits(code, [{
    start: assignExpr.right.start,
    end: assignExpr.right.end,
    replacement: replacement.replaceAll('\n', eol),
  }]);

  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function patchTypes({ upstreamRoot, babel }) {
  const file = path.join(upstreamRoot, 'src', 'types.d.ts');
  const code = await fs.readFile(file, 'utf8');
  if (code.includes('container?: string;')) {
    return false;
  }
  const eol = detectEol(code);
  const ast = parseTs(babel, code);

  const vmInjNs = findFirst(ast, n => (
    n.type === 'TSModuleDeclaration'
    && n.id?.type === 'Identifier'
    && n.id.name === 'VMInjection'
  ));
  if (!vmInjNs) {
    throw new PatchError('types.d.ts: cannot find namespace VMInjection');
  }

  const infoIface = findFirst(vmInjNs, n => (
    n.type === 'TSInterfaceDeclaration'
    && n.id?.type === 'Identifier'
    && n.id.name === 'Info'
  ));
  if (!infoIface) {
    throw new PatchError('types.d.ts: cannot find interface VMInjection.Info');
  }

  const gmiProp = findFirst(infoIface, n => {
    if (n.type !== 'TSPropertySignature') return false;
    const name = n.key?.type === 'Identifier' ? n.key.name : null;
    if (name !== 'gmi') return false;
    const ta = n.typeAnnotation?.typeAnnotation;
    return !!ta && ta.type === 'TSTypeLiteral';
  });
  if (!gmiProp) {
    throw new PatchError('types.d.ts: cannot find VMInjection.Info.gmi');
  }

  const gmiType = gmiProp.typeAnnotation.typeAnnotation;
  let isIncognitoProp;
  for (const mm of gmiType.members) {
    if (mm.type !== 'TSPropertySignature') continue;
    const n2 = mm.key?.type === 'Identifier' ? mm.key.name : null;
    if (n2 === 'container') return false;
    if (n2 === 'isIncognito') isIncognitoProp = mm;
  }
  if (!isIncognitoProp) {
    throw new PatchError('types.d.ts: cannot find VMInjection.Info.gmi.isIncognito property');
  }

  const indent = getColumnAt(code, isIncognitoProp.start, eol);
  const insertion = (eol + ' '.repeat(indent) + 'container?: string;');

  const out = applyEdits(code, [{
    start: isIncognitoProp.end,
    end: isIncognitoProp.end,
    replacement: insertion,
  }]);

  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function main() {
  const upstreamRootArg = process.argv[2] || 'upstream';
  const upstreamRoot = path.resolve(process.cwd(), upstreamRootArg);

  const { babel } = loadBabel(upstreamRoot);

  const changed = [];
  if (await patchPreinject({ upstreamRoot, babel })) {
    changed.push('src/background/utils/preinject.js');
  }
  if (await patchInject({ upstreamRoot, babel })) {
    changed.push('src/injected/content/inject.js');
  }
  if (await patchTypes({ upstreamRoot, babel })) {
    changed.push('src/types.d.ts');
  }

  if (changed.length) {
    console.log('Patched files:');
    for (const f of changed) console.log(`- ${f}`);
  } else {
    console.log('No changes needed (already patched).');
  }
}

try {
  await main();
} catch (e) {
  const msg = e?.stack || String(e);
  console.error(msg);
  process.exit(e?.name === 'PatchError' ? 2 : 1);
}
