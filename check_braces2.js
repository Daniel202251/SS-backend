const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');

const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, src);

let token;
let stack = []; // stack of {line, col, kind: 'brace'|'template'}
let inTemplate = false;

// Track template expression depth
let templateExprDepth = 0;

while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
  const pos = scanner.getStartPos();
  const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
  const line = lineInfo.line + 1;
  const col = lineInfo.character + 1;
  const lines = src.split('\n');
  const ctx = (lines[line-1] || '').substring(col-1, col+20);

  if (inTemplate) {
    // Inside template expression (${...})
    if (token === ts.SyntaxKind.CloseBraceToken) {
      // This } closes the template expression
      inTemplate = false;
    }
    // Other tokens inside template expression are part of the expression - ignore
    continue;
  }

  // Check if this starts a template literal with substitution
  if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
    // TemplateHead/TemplateMiddle is followed by ${ - the scanner will produce
    // expression tokens next, then a CloseBraceToken for the }
    inTemplate = true;
    continue;
  }

  // Not in template expression - count braces normally
  if (token === ts.SyntaxKind.OpenBraceToken) {
    stack.push({ line, col, ctx });
  }
  if (token === ts.SyntaxKind.CloseBraceToken) {
    if (stack.length > 0) {
      stack.pop();
    } else {
      console.log('EXTRA } at line ' + line + ' col ' + col + ' ctx: ' + ctx);
    }
  }
}

console.log('\nUnclosed braces: ' + stack.length);
stack.forEach(s => {
  console.log('  line ' + s.line + ' col ' + s.col + ' ctx: ' + s.ctx);
});
