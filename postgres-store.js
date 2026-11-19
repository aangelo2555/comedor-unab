const { Client } = require('pg');

async function openPostgres(onFatal = () => {}) {
  const client = new Client({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {}),
    connectionTimeoutMillis: 10000,
    query_timeout: 15000
  });
  let failure = null;
  client.on('error', (error) => {
    failure = error;
    onFatal();
  });
  try {
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS comedor_state (
      id smallint PRIMARY KEY CHECK (id = 1),
      revision bigint NOT NULL DEFAULT 0,
      document jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  let revision = null;
  async function read() {
    const result = await client.query(
      'SELECT revision, document FROM comedor_state WHERE id = 1'
    );
    revision = result.rows[0]?.revision ?? null;
    return result.rows[0]?.document || null;
  }
  return {
    read,
    ping: () => client.query('SELECT 1'),
    assertReady() {
      if (failure)
        throw new Error(
          'PostgreSQL perdió la conexión. Reinicia el servicio para reconectar.'
        );
    },
    async write(document) {
      let result;
      if (revision === null) {
        result = await client.query(
          'INSERT INTO comedor_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT DO NOTHING RETURNING revision',
          [document]
        );
      } else {
        result = await client.query(
          'UPDATE comedor_state SET document = $1::jsonb, revision = revision + 1, updated_at = now() WHERE id = 1 AND revision = $2 RETURNING revision',
          [document, revision]
        );
      }
      if (!result.rowCount) {
        const error = new Error(
          'El estado cambió en otra instancia. Repite la operación.'
        );
        error.code = 'STATE_CONFLICT';
        throw error;
      }
      revision = result.rows[0].revision;
    },
    close: () => client.end()
  };
}

module.exports = { openPostgres };
