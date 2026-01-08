//+------------------------------------------------------------------+
//|                                          DistortSignalsEA.mq5    |
//|                        DistortSignals Execution Officer          |
//|                                                                  |
//+------------------------------------------------------------------+
#property copyright "DistortSignals"
#property link      "https://github.com/amitkraj-akk47/DistortSignalsRepoV2"
#property version   "1.00"
#property strict

// Input parameters
input string DirectorEndpointsURL = "https://director.example.com";
input string APIKey = "your-api-key-here";
input string ExecutionOfficerID = "eo-001";
input int PollIntervalSeconds = 5;
input int MaxSlippagePoints = 10;
input double DefaultLotSize = 0.01;

// Global variables
datetime lastPollTime = 0;
int pollInterval = PollIntervalSeconds * 1000; // Convert to milliseconds

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    Print("DistortSignals Execution Officer starting...");
    Print("Officer ID: ", ExecutionOfficerID);
    Print("Director API: ", DirectorEndpointsURL);
    Print("Poll Interval: ", PollIntervalSeconds, " seconds");
    
    // Validate configuration
    if(StringLen(APIKey) < 10)
    {
        Print("ERROR: Invalid API Key");
        return INIT_FAILED;
    }
    
    if(StringLen(DirectorEndpointsURL) < 10)
    {
        Print("ERROR: Invalid Director URL");
        return INIT_FAILED;
    }
    
    lastPollTime = TimeCurrent();
    
    return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
    Print("DistortSignals Execution Officer stopping. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    // Check if it's time to poll for new directives
    datetime currentTime = TimeCurrent();
    
    if(currentTime - lastPollTime >= PollIntervalSeconds)
    {
        PollForDirectives();
        lastPollTime = currentTime;
    }
}

//+------------------------------------------------------------------+
//| Poll for new directives from Director API                        |
//+------------------------------------------------------------------+
void PollForDirectives()
{
    string url = DirectorEndpointsURL + "/v1/directives/pending?officer=" + ExecutionOfficerID;
    string headers = "X-API-Key: " + APIKey + "\r\n";
    
    char data[];
    char result[];
    string resultHeaders;
    
    // HTTP GET request
    int timeout = 5000;
    int res = WebRequest("GET", url, headers, timeout, data, result, resultHeaders);
    
    if(res == 200)
    {
        string response = CharArrayToString(result);
        ProcessDirectives(response);
    }
    else if(res == -1)
    {
        Print("ERROR: WebRequest failed. Error code: ", GetLastError());
        Print("Make sure URL is in allowed list: Tools -> Options -> Expert Advisors");
    }
    else
    {
        Print("ERROR: HTTP ", res, " from Director API");
    }
}

//+------------------------------------------------------------------+
//| Process directives received from API                             |
//+------------------------------------------------------------------+
void ProcessDirectives(string jsonResponse)
{
    // TODO: Parse JSON response
    // For now, just log
    Print("Received directives: ", jsonResponse);
    
    // Example directive processing:
    // 1. Parse JSON to extract directive details
    // 2. For each directive:
    //    - Validate directive data
    //    - Execute trade based on action type
    //    - Report execution event back to API
}

//+------------------------------------------------------------------+
//| Execute trade directive                                          |
//+------------------------------------------------------------------+
bool ExecuteDirective(string directiveID, string symbol, string action, 
                      double quantity, double price, double sl, double tp)
{
    Print("Executing directive: ", directiveID);
    
    ENUM_ORDER_TYPE orderType;
    
    // Map action to order type
    if(action == "OPEN_LONG")
        orderType = ORDER_TYPE_BUY;
    else if(action == "OPEN_SHORT")
        orderType = ORDER_TYPE_SELL;
    else if(action == "CLOSE")
    {
        ClosePositions(symbol);
        return true;
    }
    else
    {
        Print("ERROR: Unknown action type: ", action);
        ReportExecutionEvent(directiveID, "ORDER_REJECTED", "Unknown action type");
        return false;
    }
    
    // Place order
    MqlTradeRequest request = {};
    MqlTradeResult result = {};
    
    request.action = TRADE_ACTION_DEAL;
    request.symbol = symbol;
    request.volume = quantity;
    request.type = orderType;
    request.price = (orderType == ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK) : 
                                                     SymbolInfoDouble(symbol, SYMBOL_BID);
    request.sl = sl;
    request.tp = tp;
    request.deviation = MaxSlippagePoints;
    request.magic = 20260104; // Magic number: DistortSignals
    request.comment = "DS:" + directiveID;
    
    if(OrderSend(request, result))
    {
        if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
        {
            Print("Order executed successfully. Order: ", result.order, ", Deal: ", result.deal);
            ReportExecutionEvent(directiveID, "ORDER_FILLED", "Success", result.price, result.volume);
            return true;
        }
        else
        {
            Print("Order failed. Return code: ", result.retcode);
            ReportExecutionEvent(directiveID, "ORDER_REJECTED", "MT5 error: " + IntegerToString(result.retcode));
            return false;
        }
    }
    else
    {
        Print("OrderSend failed. Error: ", GetLastError());
        ReportExecutionEvent(directiveID, "ORDER_REJECTED", "OrderSend error: " + IntegerToString(GetLastError()));
        return false;
    }
}

//+------------------------------------------------------------------+
//| Close all positions for symbol                                   |
//+------------------------------------------------------------------+
void ClosePositions(string symbol)
{
    for(int i = PositionsTotal() - 1; i >= 0; i--)
    {
        ulong ticket = PositionGetTicket(i);
        
        if(PositionSelectByTicket(ticket))
        {
            if(PositionGetString(POSITION_SYMBOL) == symbol)
            {
                MqlTradeRequest request = {};
                MqlTradeResult result = {};
                
                request.action = TRADE_ACTION_DEAL;
                request.position = ticket;
                request.symbol = symbol;
                request.volume = PositionGetDouble(POSITION_VOLUME);
                request.type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 
                               ORDER_TYPE_SELL : ORDER_TYPE_BUY;
                request.price = (request.type == ORDER_TYPE_SELL) ? 
                               SymbolInfoDouble(symbol, SYMBOL_BID) : 
                               SymbolInfoDouble(symbol, SYMBOL_ASK);
                request.deviation = MaxSlippagePoints;
                
                OrderSend(request, result);
                Print("Closed position: ", ticket);
            }
        }
    }
}

//+------------------------------------------------------------------+
//| Report execution event back to Communication Hub                 |
//+------------------------------------------------------------------+
void ReportExecutionEvent(string directiveID, string eventType, string message,
                          double fillPrice = 0.0, double fillQuantity = 0.0)
{
    string url = DirectorEndpointsURL + "/v1/execution-events";
    
    // Build JSON payload
    string json = "{";
    json += "\"directive_id\":\"" + directiveID + "\",";
    json += "\"event_type\":\"" + eventType + "\",";
    json += "\"event_class\":\"INFO\",";
    json += "\"occurred_at\":\"" + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\",";
    json += "\"reported_by\":\"" + ExecutionOfficerID + "\"";
    
    if(fillPrice > 0)
        json += ",\"fill_price\":" + DoubleToString(fillPrice, 5);
    
    if(fillQuantity > 0)
        json += ",\"fill_quantity\":" + DoubleToString(fillQuantity, 2);
    
    if(StringLen(message) > 0)
        json += ",\"message\":\"" + message + "\"";
    
    json += "}";
    
    // Send HTTP POST
    char data[];
    char result[];
    string resultHeaders;
    string headers = "Content-Type: application/json\r\nX-API-Key: " + APIKey + "\r\n";
    
    StringToCharArray(json, data, 0, StringLen(json));
    
    int res = WebRequest("POST", url, headers, 5000, data, result, resultHeaders);
    
    if(res == 200 || res == 201)
    {
        Print("Execution event reported successfully");
    }
    else
    {
        Print("ERROR: Failed to report execution event. HTTP ", res);
    }
}

//+------------------------------------------------------------------+
