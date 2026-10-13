export const PUBLICATIONS = {
  churchtimes: {
    id: 'churchtimes',
    name: 'Church Times Nigeria',
    domain: 'churchtimesnigeria.net',
    defaultCategory: 'General News',
    stagingAllowlist: ['localhost', '127.0.0.1', 'cms.example.test', 'staging.churchtimesnigeria.net'],
    isolateDatabase: true,
  },
  investnaira: {
    id: 'investnaira',
    name: 'InvestNaira',
    domain: 'investnaira.com',
    defaultCategory: 'Financial Intelligence',
    stagingAllowlist: ['localhost', '127.0.0.1', 'cms.example.test', 'staging.investnaira.com'],
    isolateDatabase: true,
  },
};

export function getPublicationConfig(pubId = 'churchtimes') {
  const config = PUBLICATIONS[pubId];
  if (!config) {
    throw new Error(`Unknown publication ID: "${pubId}". Available options: ${Object.keys(PUBLICATIONS).join(', ')}`);
  }
  return config;
}

export function isAllowedStagingHost(host, pubConfig) {
  if (!host) return false;
  const cleanHost = host.split(':')[0].toLowerCase();
  return pubConfig.stagingAllowlist.includes(cleanHost);
}
