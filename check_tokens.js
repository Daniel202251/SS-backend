const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');
const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, src);
const lines = src.split('\n');

let token;
let lineNum = 0;

while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
  const pos = scanner.getStartPos();
  const li = sourceFile.getLineAndCharacterOfPosition(pos);
  lineNum = li.line + 1;
  const col = li.character + 1;

  // Print tokens around lines 159 and 169
  if (lineNum >= 159 && lineNum <= 172) {
    const ctx = (lines[lineNum-1] || '').substring(col-1, col+40);
    console.log('L' + lineNum + ':' + col + ' kind=' + token + '(' + ts.SyntaxKind[token] + ') val="' + scanner.getTokenValue() + '" ctx: ' + ctx.trim().substring(0, 60));
  }
}
