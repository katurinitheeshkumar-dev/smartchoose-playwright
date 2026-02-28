// SmartChoose — Railway Deploy via REST API
// Usage: node deploy-railway.js YOUR_TOKEN
// This completely bypasses Railway CLI issues

const https = require('https');
const fs = require('fs');
const path = require('path');

const token = process.argv[2];
if (!token) {
    console.error('Usage: node deploy-railway.js YOUR_TOKEN');
    process.exit(1);
}

function gqlRequest(query, variables = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query, variables });
        const req = https.request({
            hostname: 'backboard.railway.app',
            path: '/graphql/v2',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Content-Length': Buffer.byteLength(body),
            }
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.errors) reject(new Error(JSON.stringify(parsed.errors)));
                    else resolve(parsed.data);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function main() {
    console.log('Step 1: Getting your Railway account...');

    const me = await gqlRequest(`query { me { id email name } }`);
    console.log(`   Logged in as: ${me.me.email}`);

    console.log('Step 2: Creating project...');
    const project = await gqlRequest(`
    mutation ProjectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }
  `, { input: { name: 'smartchoose-playwright' } });

    const projectId = project.projectCreate.id;
    console.log(`   Project created: ${projectId}`);

    console.log('Step 3: Creating environment...');
    const envs = await gqlRequest(`
    query { project(id: "${projectId}") { environments { edges { node { id name } } } } }
  `);
    const envId = envs.project.environments.edges[0]?.node?.id;
    console.log(`   Environment ID: ${envId}`);

    console.log(`\n====================================================`);
    console.log(`Project created! Now do this:`);
    console.log(`1. Go to https://railway.app/project/${projectId}`);
    console.log(`2. Click "Deploy" -> "GitHub Repo" or "Deploy from Dockerfile"`);
    console.log(`3. OR use this Project ID in next steps`);
    console.log(`====================================================`);
    console.log(`Project ID: ${projectId}`);
    console.log(`Environment ID: ${envId}`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
