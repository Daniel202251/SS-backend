const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');
const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, src);
let token;
let inTemplate = false;
const lines = src.split('\n');

while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
  const pos = scanner.getStartPos();
  const li = sourceFile.getLineAndCharacterOfPosition(pos);
  const lineNum = li.line + 1;
  const col = li.character + 1;
  const ctx = (lines[lineNum-1] || '').substring(col-1, col+30);

  // Print template-related tokens
  if (token === ts.SyntaxKind.TemplateHead) {
    console.log('TemplateHead L' + lineNum + ' val: "' + scanner.getTokenValue() + '"');
    inTemplate = true;
  } else if (token === ts.SyntaxKind.TemplateMiddle) {
    console.log('TemplateMiddle L' + lineNum + ' val: "' + scanner.getTokenValue() + '"');
    inTemplate = true;
  } else if (token === ts.SyntaxKind.CloseBraceToken) {
    if (inTemplate) {
      console.log('CLOSE_BRACE (template) L' + lineNum);
      inTemplate = false;
    }
  }
  if (token === ts.SyntaxKind.TemplateTail) {
    console.log('TemplateTail L' + lineNum + ' val: "' + scanner.getTokenValue() + '"');
    inTemplate = false;
  }
  if (token === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    console.log('NoSubstitutionTemplate L' + lineNum + ' val: "' + scanner.getTokenValue() + '"');
  }
}

console.log('\nTemplate tracking complete');
