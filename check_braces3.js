const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');
const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, src);

let token;
let stack = [];
let inTemplate = false;
const lines = src.split('\n');

while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
  const pos = scanner.getStartPos();
  const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
  const lineNum = lineInfo.line + 1;
  const col = lineInfo.character + 1;
  const ctx = (lines[lineNum-1] || '').substring(col-1, col+30);

  if (inTemplate) {
    if (token === ts.SyntaxKind.CloseBraceToken) {
      inTemplate = false;
    }
    continue;
  }

  if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
    inTemplate = true;
    continue;
  }

  if (token === ts.SyntaxKind.OpenBraceToken) {
    stack.push({ line: lineNum, col, ctx });
  }
  if (token === ts.SyntaxKind.CloseBraceToken) {
    if (stack.length > 0) {
      const opened = stack.pop();
      // Only show braces opened at depth 0-2 (top-level structures)
      if (stack.length <= 2) {
        console.log('  CLOSE line ' + lineNum + ' (closed { from line ' + opened.line + ') stack depth now: ' + stack.length);
      }
    } else {
      console.log('EXTRA } at line ' + lineNum + ' ctx: ' + ctx);
    }
  }
}

console.log('\nUnclosed:', stack.length);
stack.forEach(s => console.log('  line ' + s.line));
