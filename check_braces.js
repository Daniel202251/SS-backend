const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');

const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, src);

let token;
let inTemplateExpr = false;
let realOpen = 0;
let realClose = 0;
let fakeClose = 0;
let openStack = [];
let closeStack = [];

while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
  const pos = scanner.getStartPos();
  const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
  const line = lineInfo.line + 1;
  const col = lineInfo.character + 1;
  const lines = src.split('\n');
  const ctx = lines[line - 1]?.substring(col - 1, col + 20).replace(/\n/g, '');

  if (!inTemplateExpr) {
    if (token === ts.SyntaxKind.OpenBraceToken) {
      realOpen++;
      openStack.push({ line, col, ctx });
    }
    if (token === ts.SyntaxKind.CloseBraceToken) {
      realClose++;
      if (openStack.length > 0) {
        closeStack.push({ line, col, matched: openStack.pop(), ctx });
      } else {
        console.log('EXTRA } at line ' + line + ' col ' + col + ' context: ' + ctx);
      }
    }
    if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
      inTemplateExpr = true;
    }
  } else {
    if (token === ts.SyntaxKind.CloseBraceToken) {
      fakeClose++;
      inTemplateExpr = false;
    }
  }
}

console.log('Real OpenBraceToken:', realOpen);
console.log('Real CloseBraceToken:', realClose);
console.log('Template CloseBrace (fake):', fakeClose);
console.log('Net unclosed (real):', realOpen - realClose);
console.log('Unclosed braces:', openStack.length);
if (openStack.length > 0) {
  console.log('Unclosed brace locations:');
  openStack.forEach(u => {
    console.log('  line ' + u.line + ' col ' + u.col + ' context: ' + u.ctx);
  });
}
