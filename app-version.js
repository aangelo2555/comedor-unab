const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function applicationVersion(root) {
  function publicFiles(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
      const relative = path.join(directory, entry.name);
      return entry.isDirectory() ? publicFiles(relative) : [relative];
    });
  }
  const files = [...publicFiles('public'), ...fs.readdirSync(root).filter(file => file.endsWith('.js')), 'package.json', 'package-lock.json'];
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

module.exports = { applicationVersion };
