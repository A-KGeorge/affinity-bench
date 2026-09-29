'use strict';

// Thin loader so callers can `require('../contention-addon')` instead of
// reaching into build/Release directly.
module.exports = require('./build/Release/contention_addon.node');
