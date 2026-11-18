const { execSync } = require('child_process');
try {
  const result = execSync('cd C:\\Users\\asus\\Downloads\\LOOM && npx next build', { encoding: 'string' });
  console.log('BUILD SUCCESS');
  console.log(result);
} catch (e) {
  console.log('BUILD FAILED');
  console.log(e.stdout || e.stderr || 'Unknown error');
}