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
  const generate = requireFromUpstream('@babel/generator').default;
  return { babel, generate };
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

function genNode(generate, node) {
  return generate(node, {
    comments: true,
    compact: false,
    concise: false,
    retainLines: false,
  }).code;
}

function hasNode(root, predicate) {
  return !!findFirst(root, predicate);
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

async function patchPreinject({ upstreamRoot, babel, generate }) {
  const file = path.join(upstreamRoot, 'src', 'background', 'utils', 'preinject.js');
  const code = await fs.readFile(file, 'utf8');
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

  const bodyStmts = targetMethod.body.body;
  const findVarStmt = (name) => bodyStmts.find(s => (
    s.type === 'VariableDeclaration'
    && s.declarations?.some(d => d.id?.type === 'Identifier' && d.id.name === name)
  ));
  const containerStmt = findVarStmt('container');
  const injectInfoStmt = findVarStmt('injectInfo');
  const injectGmiStmt = findVarStmt('injectGmi');
  const injectOutStmt = findVarStmt('injectOut');
  const earlyReturnStmt = bodyStmts.find(s => (
    s.type === 'IfStatement'
    && s.test?.type === 'LogicalExpression'
    && s.test.operator === '&&'
    && s.test.left?.type === 'Identifier'
    && s.test.left.name === 'isApplied'
    && s.test.right?.type === 'Identifier'
    && s.test.right.name === 'done'
    && s.consequent?.type === 'ReturnStatement'
  ));

  const desiredAst = parseJs(babel, [
    'const container = IS_FIREFOX && isApplied && (tab.cookieStoreId || (await browser.tabs.get(tabId).catch(() => ({}))).cookieStoreId);',
    'const injectInfo = inject.info || {};',
    'const injectGmi = injectInfo.gmi || {};',
    'const injectOut = IS_FIREFOX && isApplied',
    '  ? {',
    '    __proto__: null,',
    '    ...inject,',
    '    info: {',
    '      __proto__: null,',
    '      ...injectInfo,',
    '      gmi: { __proto__: null, ...injectGmi, container: container },',
    '    },',
    '  }',
    '  : inject;',
    'if (isApplied && done) return { info: { __proto__: null, gmi: { __proto__: null, container: container } } };',
    '',
  ].join('\n')).program.body;
  const desiredByName = Object.fromEntries([
    ['container', desiredAst[0]],
    ['injectInfo', desiredAst[1]],
    ['injectGmi', desiredAst[2]],
    ['injectOut', desiredAst[3]],
    ['earlyReturn', desiredAst[4]],
  ]);

  const edits = [];
  const indent = getColumnAt(code, returnStmt.start, eol);
  const toEol = (s) => s.replaceAll('\n', eol);

  const stmtLooksOk = (stmt, name) => {
    if (!stmt) return false;
    if (name === 'container') {
      return hasNode(stmt, n => n.type === 'Identifier' && n.name === 'isApplied')
        && hasNode(stmt, n => n.type === 'Identifier' && n.name === 'tabId')
        && hasNode(stmt, n => n.type === 'Identifier' && n.name === 'cookieStoreId')
        && hasNode(stmt, n => n.type === 'MemberExpression'
          && !n.computed
          && n.object?.type === 'Identifier'
          && n.object.name === 'browser'
          && n.property?.type === 'Identifier'
          && n.property.name === 'tabs')
        && hasNode(stmt, n => n.type === 'Identifier' && n.name === 'catch');
    }
    if (name === 'injectOut') {
      return hasNode(stmt, n => n.type === 'Identifier' && n.name === 'injectGmi')
        && hasNode(stmt, n => n.type === 'Identifier' && n.name === 'container');
    }
    if (name === 'earlyReturn') {
      return hasNode(stmt, n => n.type === 'Identifier' && n.name === 'done')
        && hasNode(stmt, n => n.type === 'Identifier' && n.name === 'container');
    }
    return true;
  };

  const maybeReplaceStmt = (existing, desired, name) => {
    if (!existing) return;
    if (stmtLooksOk(existing, name)) return;
    const rep = toEol(genNode(generate, desired));
    edits.push({ start: existing.start, end: existing.end, replacement: rep });
  };
  maybeReplaceStmt(containerStmt, desiredByName.container, 'container');
  maybeReplaceStmt(injectInfoStmt, desiredByName.injectInfo, 'injectInfo');
  maybeReplaceStmt(injectGmiStmt, desiredByName.injectGmi, 'injectGmi');
  maybeReplaceStmt(injectOutStmt, desiredByName.injectOut, 'injectOut');
  maybeReplaceStmt(earlyReturnStmt, desiredByName.earlyReturn, 'earlyReturn');

  const insertStmts = [];
  if (!containerStmt) insertStmts.push(desiredByName.container);
  if (!injectInfoStmt) insertStmts.push(desiredByName.injectInfo);
  if (!injectGmiStmt) insertStmts.push(desiredByName.injectGmi);
  if (!injectOutStmt) insertStmts.push(desiredByName.injectOut);
  if (!earlyReturnStmt) insertStmts.push(desiredByName.earlyReturn);
  if (insertStmts.length) {
    const insertText = indentLines(
      insertStmts.map(s => genNode(generate, s)).join('\n'),
      indent,
    ).replaceAll('\n', eol) + eol;
    edits.push({ start: returnStmt.start, end: returnStmt.start, replacement: insertText });
  }

  const replaceInNode = (node) => {
    walk(node, (n) => {
      if (n.type === 'Identifier' && n.name === 'inject') n.name = 'injectOut';
      return undefined;
    });
  };
  const retNode = returnStmt.argument;
  replaceInNode(retNode);
  const patchedRetText = toEol(genNode(generate, returnStmt));
  edits.push({ start: returnStmt.start, end: returnStmt.end, replacement: patchedRetText });

  const out = applyEdits(code, edits);
  if (out === code) return false;
  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function patchContentIndex({ upstreamRoot, babel, generate }) {
  const file = path.join(upstreamRoot, 'src', 'injected', 'content', 'index.js');
  const code = await fs.readFile(file, 'utf8');
  const eol = detectEol(code);
  const ast = parseJs(babel, code);

  const initFn = findFirst(ast, n => (
    n.type === 'FunctionDeclaration'
    && n.id?.type === 'Identifier'
    && n.id.name === 'init'
  ));
  if (!initFn) {
    throw new PatchError('content/index.js: cannot find function init');
  }

  const infoStmt = initFn.body.body.find(s => {
    if (s.type !== 'VariableDeclaration') return false;
    const d = s.declarations?.[0];
    if (!d || d.id?.type !== 'Identifier' || d.id.name !== 'info') return false;
    const init = d.init;
    return init?.type === 'MemberExpression'
      && init.object?.type === 'Identifier'
      && init.object.name === 'data'
      && init.property?.type === 'Identifier'
      && init.property.name === 'info';
  });
  if (!infoStmt) {
    throw new PatchError('content/index.js: cannot find statement "const info = data.info;"');
  }

  const bodyStmts = initFn.body.body;
  const idx = bodyStmts.indexOf(infoStmt);
  const next = idx >= 0 ? bodyStmts[idx + 1] : null;

  const desiredIfAst = parseJs(babel, [
    "if (IS_FIREFOX && info && (!info.gmi || !('container' in info.gmi))) {",
    '  try {',
    '    const extra = await dataPromise;',
    '    const extraGmi = extra && extra.info && extra.info.gmi;',
    '    if (extraGmi) info.gmi = assign(info.gmi || createNullObj(), extraGmi);',
    '  } catch (e) { void e; }',
    '}',
  ].join('\n')).program.body[0];

  const isOurIf = (stmt) => stmt?.type === 'IfStatement'
    && hasNode(stmt, n => n.type === 'StringLiteral' && n.value === 'container');

  if (isOurIf(next)) {
    const desiredText = genNode(generate, desiredIfAst).replaceAll('\n', eol);
    const currentOk = hasNode(next, n => n.type === 'UnaryExpression'
      && n.operator === 'void'
      && n.argument?.type === 'Identifier'
      && n.argument.name === 'e');
    if (currentOk) return false;
    const out = applyEdits(code, [{ start: next.start, end: next.end, replacement: desiredText }]);
    await fs.writeFile(file, out, 'utf8');
    return true;
  }

  const indent = getColumnAt(code, infoStmt.start, eol);
  const insertText = eol + indentLines(genNode(generate, desiredIfAst), indent).replaceAll('\n', eol) + eol;
  const out = applyEdits(code, [{ start: infoStmt.end, end: infoStmt.end, replacement: insertText }]);
  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function patchInject({ upstreamRoot, babel, generate }) {
  const file = path.join(upstreamRoot, 'src', 'injected', 'content', 'inject.js');
  const code = await fs.readFile(file, 'utf8');
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
      && n.right.callee.name === 'assign') {
      const a0 = n.right.arguments?.[0];
      return !(a0?.type === 'LogicalExpression'
        && a0.operator === '||'
        && a0.left?.type === 'MemberExpression'
        && a0.left.object?.type === 'Identifier'
        && a0.left.object.name === 'info'
        && a0.left.property?.type === 'Identifier'
        && a0.left.property.name === 'gmi'
        && a0.right?.type === 'CallExpression'
        && a0.right.callee?.type === 'Identifier'
        && a0.right.callee.name === 'createNullObj');
    }
    return n.right.type === 'ObjectExpression';
  });

  if (!assignExpr) {
    throw new PatchError('inject.js: cannot find assignment "info.gmi = { ... }" in injectScripts');
  }

  if (assignExpr.right.type === 'CallExpression'
    && assignExpr.right.callee.type === 'Identifier'
    && assignExpr.right.callee.name === 'assign') {
    return false;
  }

  const desiredExprAst = parseJs(babel, 'assign(info.gmi || createNullObj(), {});')
    .program.body[0].expression;
  desiredExprAst.arguments[1] = assignExpr.right; // reuse original object literal
  const replacement = genNode(generate, desiredExprAst).replaceAll('\n', eol);

  const out = applyEdits(code, [{
    start: assignExpr.right.start,
    end: assignExpr.right.end,
    replacement: replacement,
  }]);

  await fs.writeFile(file, out, 'utf8');
  return true;
}

async function patchTypes({ upstreamRoot, babel }) {
  const file = path.join(upstreamRoot, 'src', 'types.d.ts');
  const code = await fs.readFile(file, 'utf8');
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

  const { babel, generate } = loadBabel(upstreamRoot);

  const changed = [];
  if (await patchPreinject({ upstreamRoot, babel, generate })) {
    changed.push('src/background/utils/preinject.js');
  }
  if (await patchContentIndex({ upstreamRoot, babel, generate })) {
    changed.push('src/injected/content/index.js');
  }
  if (await patchInject({ upstreamRoot, babel, generate })) {
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
