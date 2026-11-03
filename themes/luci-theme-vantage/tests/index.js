'use strict';
/* `node --test tests/` resolves the directory to this file (Node treats a
   directory argument as a module path); it loads every *.test.js here so
   both `node --test tests/` and a plain `node --test` run the suite. */
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort())
	require(path.join(__dirname, f));
