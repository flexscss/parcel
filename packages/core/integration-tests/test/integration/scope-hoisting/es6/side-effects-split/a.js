// ensure lib is hoisted (without using any exports) to simulate bundle reference in b.js
import 'lib';

module.exports = import('./b').then(p => p.default + 456);
