const acorn = require('acorn');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');

// Strip TypeScript-specific syntax for acorn
// Let's try parsing with allowReturnOutsideFunction and other options
try {
  const ast = acorn.parse(src, {
    ecmaVersion: 2022,
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    locations: true,
  });
  console.log('Parse OK');
} catch (e) {
  console.log('Parse error: ' + e.message);
  console.log('At line ' + e.loc?.line + ' col ' + e.loc?.column);
}
