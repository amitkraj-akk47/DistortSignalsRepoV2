#!/usr/bin/env node
/**
 * DistortSignals - New Service Generator
 * Generates boilerplate for new services
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('🏗️  DistortSignals Service Generator\n');

  const serviceType = await question('Service type (typescript/python/mt5): ');
  const serviceName = await question('Service name (kebab-case): ');
  const description = await question('Description: ');

  const projectRoot = path.join(__dirname, '../..');
  
  switch (serviceType) {
    case 'typescript':
      await generateTypescriptService(projectRoot, serviceName, description);
      break;
    case 'python':
      await generatePythonService(projectRoot, serviceName, description);
      break;
    case 'mt5':
      await generateMt5Service(projectRoot, serviceName, description);
      break;
    default:
      console.error('❌ Invalid service type');
      process.exit(1);
  }

  console.log(`\n✅ Service ${serviceName} created successfully!`);
  rl.close();
}

async function generateTypescriptService(root, name, description) {
  const servicePath = path.join(root, 'apps/typescript', name);
  
  fs.mkdirSync(path.join(servicePath, 'src'), { recursive: true });
  
  // package.json
  fs.writeFileSync(
    path.join(servicePath, 'package.json'),
    JSON.stringify({
      name: `@distortsignals/${name}`,
      version: '1.0.0',
      private: true,
      scripts: {
        dev: 'wrangler dev',
        deploy: 'wrangler deploy'
      },
      dependencies: {
        '@distortsignals/ts-core': 'workspace:*',
        '@distortsignals/ts-contracts': 'workspace:*'
      }
    }, null, 2)
  );
  
  // index.ts
  fs.writeFileSync(
    path.join(servicePath, 'src/index.ts'),
    `// ${description}\n\nexport default {\n  async fetch(request: Request): Promise<Response> {\n    return new Response('Hello from ${name}');\n  }\n};\n`
  );
  
  // README.md
  fs.writeFileSync(
    path.join(servicePath, 'README.md'),
    `# ${name}\n\n${description}\n`
  );
}

async function generatePythonService(root, name, description) {
  const servicePath = path.join(root, 'apps/python', name);
  
  fs.mkdirSync(path.join(servicePath, 'src'), { recursive: true });
  fs.mkdirSync(path.join(servicePath, 'tests'), { recursive: true });
  
  // pyproject.toml
  fs.writeFileSync(
    path.join(servicePath, 'pyproject.toml'),
    `[tool.poetry]\nname = "${name}"\nversion = "1.0.0"\ndescription = "${description}"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nds-shared = { path = "../shared", develop = true }\n\n[build-system]\nrequires = ["poetry-core"]\nbuild-backend = "poetry.core.masonry.api"\n`
  );
  
  // main.py
  fs.writeFileSync(
    path.join(servicePath, 'src/main.py'),
    `"""${description}"""\n\ndef main():\n    print("Hello from ${name}")\n\nif __name__ == "__main__":\n    main()\n`
  );
}

async function generateMt5Service(root, name, description) {
  console.log('MT5 service generation not yet implemented');
}

main().catch(console.error);
