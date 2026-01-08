/**
 * Cloudflare Worker Configuration Template
 * Use this as a reference for wrangler.toml files
 */

module.exports = {
  // Worker configuration
  worker: {
    name: 'worker-name',
    main: 'src/index.ts',
    compatibility_date: '2024-01-01',
  },

  // Environment bindings
  bindings: {
    // KV Namespaces
    kv_namespaces: [
      { binding: 'CACHE', id: 'your-kv-id', preview_id: 'preview-kv-id' }
    ],

    // D1 Databases
    d1_databases: [
      { binding: 'DB', database_name: 'distortsignals', database_id: 'your-d1-id' }
    ],

    // Durable Objects
    durable_objects: {
      bindings: [
        { name: 'CONNECTION_MANAGER', class_name: 'ConnectionManager', script_name: 'worker-name' }
      ]
    },

    // Queues
    queues: {
      producers: [
        { binding: 'QUEUE', queue: 'directive-queue' }
      ],
      consumers: [
        { queue: 'directive-queue', max_batch_size: 10, max_batch_timeout: 5 }
      ]
    },

    // Environment Variables
    vars: {
      ENVIRONMENT: 'production',
      LOG_LEVEL: 'info'
    }
  },

  // Routes
  routes: [
    { pattern: 'api.distortsignals.com/*', zone_name: 'distortsignals.com' }
  ],

  // Triggers
  triggers: {
    crons: ['*/5 * * * *'] // Every 5 minutes
  }
};
