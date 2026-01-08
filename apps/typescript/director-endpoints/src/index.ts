/**
 * Director Endpoints Worker
 * BFF for Trade Director service
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  DIRECTOR_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'healthy', service: 'director-endpoints' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Authentication check
    const apiKey = request.headers.get('X-API-Key');
    if (apiKey !== env.DIRECTOR_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /v1/directives - Create trade directive
    if (url.pathname === '/v1/directives' && request.method === 'POST') {
      try {
        const directive = await request.json();

        // Validate directive
        if (!directive.symbol || !directive.action || !directive.quantity) {
          return new Response(JSON.stringify({ error: 'Invalid directive data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // TODO: Insert into Supabase trade_directives table
        const directiveId = `dir_${Date.now()}`;

        return new Response(
          JSON.stringify({ success: true, directiveId }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (error) {
        console.error('Error creating directive:', error);
        return new Response(JSON.stringify({ error: 'Failed to create directive' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /v1/directives/:id - Get directive status
    if (url.pathname.match(/^\/v1\/directives\/[^/]+$/) && request.method === 'GET') {
      const directiveId = url.pathname.split('/')[3];

      try {
        // TODO: Fetch from Supabase
        const directive = {
          directiveId,
          status: 'PENDING',
          symbol: 'EURUSD',
          action: 'OPEN_LONG',
          quantity: 0.01,
        };

        return new Response(JSON.stringify(directive), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error fetching directive:', error);
        return new Response(JSON.stringify({ error: 'Directive not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /v1/signals/pending - Get pending signals for director
    if (url.pathname === '/v1/signals/pending' && request.method === 'GET') {
      try {
        // TODO: Fetch from Supabase signal_outbox where status='PUBLISHED'
        const signals = [
          {
            signalId: 'sig_001',
            symbol: 'EURUSD',
            signalType: 'BUY',
            confidence: 0.85,
            price: 1.0950,
            generatedAt: new Date().toISOString(),
          },
        ];

        return new Response(JSON.stringify({ signals }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error fetching pending signals:', error);
        return new Response(JSON.stringify({ error: 'Failed to fetch signals' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
