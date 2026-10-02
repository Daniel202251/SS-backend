const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');

// Parse the source file with error recovery (scanning for syntax errors)
const sourceFile = ts.createSourceFile(
  'test.ts',
  src,
  ts.ScriptTarget.ES2022,
  /*setParentNodes*/ false,
  ts.ScriptKind.TS
);

// Get diagnostics from the source file's parse
const parseDiagnostics = sourceFile.parseDiagnostics || [];
console.log('Parse diagnostics:', parseDiagnostics.length);
parseDiagnostics.forEach(d => {
  const pos = sourceFile.getLineAndCharacterOfPosition(d.start);
  console.log('  Line', pos.line + 1, 'col', pos.character + 1 + ':', ts.flattenDiagnosticMessageText(d.messageText, '\n'));
});

// Check the last token
const lastToken = ts.getLastToken(sourceFile);
console.log('\nLast token kind:', ts.SyntaxKind[lastToken.kind], 'at pos', lastToken.getStart());
const lines = src.split('\n');
console.log('Lines in file:', lines.length);
console.log('Last line:', JSON.stringify(lines[lines.length - 1]));
