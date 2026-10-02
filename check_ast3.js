const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('tests/integration/auth-jwt-validation.test.ts', 'utf8');

// Parse without error recovery
const sourceFile = ts.createSourceFile('test.ts', src, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);

// Walk the AST and track describe/it blocks
function walk(node, depth) {
  if (ts.isExpressionStatement(node)) {
    // Check if it's a describe() or it() call
    if (ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression;
      if (callee && ts.isIdentifier(callee)) {
        const name = callee.text;
        if (name === 'describe' || name === 'it' || name === 'it' || name === 'it.each') {
          // Check if the callback has balanced braces
          const args = node.expression.arguments;
          if (args.length > 0 && ts.isArrowFunction(args[args.length - 1])) {
            const arrow = args[args.length - 1];
            if (arrow.body && ts.isBlock(arrow.body)) {
              console.log(name + ' at pos ' + node.getStart() + ' end: ' + node.getEnd() + ' (body span: ' + arrow.body.getStart() + '-' + arrow.body.getEnd() + ')');
            }
          }
        }
      }
    }
  }
  ts.forEachChild(node, child => walk(child, depth + 1));
}

walk(sourceFile, 0);
