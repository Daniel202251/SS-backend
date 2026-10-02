const ts = require('typescript');
const fs = require('fs');

const filePath = 'tests/integration/auth-jwt-validation.test.ts';
const src = fs.readFileSync(filePath, 'utf8');

// Create program with minimal options
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  baseUrl: '.',
  paths: { '@/*': ['src/*'] },
  types: ['node', 'express', 'jest'],
  noEmit: true,
};

const program = ts.createProgram([filePath], options);
const sourceFile = program.getSourceFile(filePath);

if (sourceFile) {
  // Only syntax diagnostics (from parseDiagnostics)
  console.log('=== Source file parse diagnostics ===');
  const parseDiags = sourceFile.parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) {
    parseDiags.forEach(d => {
      const pos = sourceFile.getLineAndCharacterOfPosition(d.start);
      const cat = ts.DiagnosticCategory[d.category];
      console.log('  [' + cat + '] Line ' + (pos.line + 1) + ' col ' + (pos.character + 1) + ': ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    });
  } else {
    console.log('  No parse diagnostics');
  }

  // Full diagnostics from program
  console.log('\n=== Program diagnostics ===');
  const allDiags = ts.getPreEmitDiagnostics(program, sourceFile);
  allDiags.forEach(d => {
    const pos = sourceFile.getLineAndCharacterOfPosition(d.start);
    const cat = ts.DiagnosticCategory[d.category];
    console.log('  [' + cat + '] Line ' + (pos.line + 1) + ' col ' + (pos.character + 1) + ': ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  });
  console.log('Total diagnostics:', allDiags.length);
}
