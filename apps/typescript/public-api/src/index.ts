/**
 * Public API Worker
 * Public-facing REST API for trading signals
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  JWT_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'healthy', service: 'public-api' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Authentication check
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /v1/signals - List recent signals
    if (url.pathname === '/v1/signals' && request.method === 'GET') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const symbol = url.searchParams.get('symbol');

        // TODO: Fetch from Supabase
        const signals = [
          {
            signalId: 'sig_001',
            symbol: 'EURUSD',
            type: 'BUY',
            confidence: 0.85,
            price: 1.0950,
            generatedAt: new Date().toISOString(),
          },
        ];

        return new Response(JSON.stringify({ signals, count: signals.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error fetching signals:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /v1/signals/:id - Get specific signal
    if (url.pathname.match(/^\/v1\/signals\/[^/]+$/) && request.method === 'GET') {
      const signalId = url.pathname.split('/')[3];
      
      try {
        // TODO: Fetch from Supabase
        const signal = {
          signalId,
          symbol: 'EURUSD',
          type: 'BUY',
          confidence: 0.85,
          price: 1.0950,
          generatedAt: new Date().toISOString(),
        };

        return new Response(JSON.stringify(signal), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error fetching signal:', error);
        return new Response(JSON.stringify({ error: 'Signal not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
