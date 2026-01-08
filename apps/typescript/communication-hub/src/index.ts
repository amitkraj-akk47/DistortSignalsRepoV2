/**
 * Communication Hub Worker
 * Central event routing and pub/sub system
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'healthy', service: 'communication-hub' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Event publishing endpoint
    if (url.pathname.startsWith('/events/') && request.method === 'POST') {
      const eventType = url.pathname.split('/')[2];
      
      try {
        const event = await request.json();
        
        // Validate event
        if (!event || typeof event !== 'object') {
          return new Response(JSON.stringify({ error: 'Invalid event data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Add metadata
        const enrichedEvent = {
          ...event,
          eventType,
          receivedAt: new Date().toISOString(),
        };

        // Route based on event type
        switch (eventType) {
          case 'tick':
            await routeTickEvent(enrichedEvent, env);
            break;
          case 'signal':
            await routeSignalEvent(enrichedEvent, env);
            break;
          case 'directive':
            await routeDirectiveEvent(enrichedEvent, env);
            break;
          case 'execution':
            await routeExecutionEvent(enrichedEvent, env);
            break;
          case 'heartbeat':
            console.log('Heartbeat received:', enrichedEvent);
            break;
          default:
            console.warn('Unknown event type:', eventType);
        }

        return new Response(
          JSON.stringify({ success: true, eventType }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (error) {
        console.error('Error processing event:', error);
        return new Response(JSON.stringify({ error: 'Failed to process event' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

async function routeTickEvent(event: any, env: Env): Promise<void> {
  // Forward to Signal Generator (via queue or direct call)
  console.log('Routing tick event:', event);
  // TODO: Implement actual routing logic
}

async function routeSignalEvent(event: any, env: Env): Promise<void> {
  // Store in signal_outbox table
  console.log('Routing signal event:', event);
  // TODO: Implement Supabase integration
}

async function routeDirectiveEvent(event: any, env: Env): Promise<void> {
  // Store in trade_directives table
  console.log('Routing directive event:', event);
  // TODO: Implement Supabase integration
}

async function routeExecutionEvent(event: any, env: Env): Promise<void> {
  // Store in execution_events table
  console.log('Routing execution event:', event);
  // TODO: Implement Supabase integration
}
