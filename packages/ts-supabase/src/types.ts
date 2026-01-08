/**
 * Database type definitions
 * Generated from Supabase schema
 */

export interface Database {
  public: {
    Tables: {
      signal_outbox: {
        Row: {
          id: string;
          created_at: string;
          symbol: string;
          direction: 'BUY' | 'SELL';
          entry_price: number;
          stop_loss: number;
          take_profit: number;
          status: 'pending' | 'active' | 'filled' | 'cancelled';
        };
        Insert: Omit<Database['public']['Tables']['signal_outbox']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['signal_outbox']['Insert']>;
      };
      trade_directives: {
        Row: {
          id: string;
          created_at: string;
          signal_id: string;
          directive_type: string;
          parameters: Record<string, unknown>;
          status: string;
        };
        Insert: Omit<Database['public']['Tables']['trade_directives']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['trade_directives']['Insert']>;
      };
      execution_events: {
        Row: {
          id: string;
          created_at: string;
          directive_id: string;
          event_type: string;
          event_data: Record<string, unknown>;
        };
        Insert: Omit<Database['public']['Tables']['execution_events']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['execution_events']['Insert']>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      signal_direction: 'BUY' | 'SELL';
      signal_status: 'pending' | 'active' | 'filled' | 'cancelled';
    };
  };
}
