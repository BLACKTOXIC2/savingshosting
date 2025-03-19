const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Initialize Supabase client
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('Missing Supabase credentials. Please check your .env file');
  process.exit(1);
}

let supabase;
try {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: true
      }
    }
  );
} catch (error) {
  console.error('Error initializing Supabase client:', error);
  process.exit(1);
}

// Initialize database schema if not exists
async function initializeSchema() {
  try {
    // Create deal_type enum if not exists
    await supabase.rpc('create_deal_type_if_not_exists', {});

    // Check if coupons_deals table exists
    const { data: tablesData, error: tablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_name', 'coupons_deals')
      .eq('table_schema', 'public');

    if (tablesError) {
      console.error('Error checking for coupons_deals table:', tablesError);
      return;
    }

    // If table doesn't exist, create it
    if (!tablesData || tablesData.length === 0) {
      console.log('Creating coupons_deals table...');
      
      // Create the table
      const { error: createError } = await supabase.rpc('create_coupons_deals_table', {});
      
      if (createError) {
        console.error('Error creating coupons_deals table:', createError);
        return;
      }
      
      console.log('coupons_deals table created successfully');
    } else {
      console.log('coupons_deals table already exists');
    }
  } catch (error) {
    console.error('Error initializing schema:', error);
  }
}

// Create stored procedures for schema initialization
async function createStoredProcedures() {
  try {
    // Create procedure for deal_type enum
    const { error: enumProcError } = await supabase.rpc('execute_sql', {
      sql: `
        CREATE OR REPLACE FUNCTION create_deal_type_if_not_exists()
        RETURNS void AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_type') THEN
            CREATE TYPE deal_type AS ENUM ('coupon', 'deal');
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `
    });

    if (enumProcError) {
      console.error('Error creating deal_type procedure:', enumProcError);
    }

    // Create procedure for coupons_deals table
    const { error: tableProcError } = await supabase.rpc('execute_sql', {
      sql: `
        CREATE OR REPLACE FUNCTION create_coupons_deals_table()
        RETURNS void AS $$
        BEGIN
          CREATE TABLE IF NOT EXISTS coupons_deals (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            type deal_type NOT NULL,
            brand_id UUID REFERENCES brands(id) NOT NULL,
            coupon_code TEXT,
            deal_url TEXT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            start_time TIMESTAMPTZ NOT NULL,
            expiry_time TIMESTAMPTZ NOT NULL,
            offer_percentage NUMERIC(5,2),
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          
          ALTER TABLE coupons_deals ENABLE ROW LEVEL SECURITY;
          
          DROP POLICY IF EXISTS "Users can insert coupons and deals for their brands" ON coupons_deals;
          CREATE POLICY "Users can insert coupons and deals for their brands" ON coupons_deals
            FOR INSERT
            TO authenticated
            WITH CHECK (
              EXISTS (
                SELECT 1 FROM brands
                WHERE id = brand_id
                AND user_id = auth.uid()
              )
            );
        END;
        $$ LANGUAGE plpgsql;
      `
    });

    if (tableProcError) {
      console.error('Error creating coupons_deals table procedure:', tableProcError);
    }

    // Create SQL execution function if it doesn't exist
    const { error: sqlExecError } = await supabase.rpc('execute_sql', {
      sql: `
        CREATE OR REPLACE FUNCTION execute_sql(sql text)
        RETURNS void AS $$
        BEGIN
          EXECUTE sql;
        END;
        $$ LANGUAGE plpgsql SECURITY DEFINER;
      `
    });

    if (sqlExecError) {
      console.error('Error creating SQL execution function:', sqlExecError);
    }
  } catch (error) {
    console.error('Error creating stored procedures:', error);
  }
}

// Helper function to query data from Supabase tables
async function querySupabaseTables(message) {
  try {
    const messageLC = message.toLowerCase();
    console.log('Processing query for message:', message);

    // Query brands table with their deals
    const { data: brands, error: brandsError } = await supabase
      .from('brands')
      .select('*');

    if (brandsError) {
      console.error('Error fetching brands:', brandsError);
      throw new Error('Failed to fetch brands data');
    }

    if (!brands || brands.length === 0) {
      console.log('No brands found in database');
      return { brands: [], couponsDeals: [] };
    }

    // First, build the base query
    let couponsDealsQuery = supabase
      .from('coupons_deals')
      .select('*, brands(*)');
    
    // Add expiry time filter - only active deals
    couponsDealsQuery = couponsDealsQuery.gt('expiry_time', new Date().toISOString());

    // Apply filters based on message content
    if (messageLC.includes('coupon')) {
      couponsDealsQuery = couponsDealsQuery.eq('type', 'coupon');
    } else if (messageLC.includes('deal')) {
      couponsDealsQuery = couponsDealsQuery.eq('type', 'deal');
    }

    // Check for percentage mentions
    const percentageMatch = messageLC.match(/(\d+)%/);
    if (percentageMatch) {
      const percentage = parseInt(percentageMatch[1]);
      couponsDealsQuery = couponsDealsQuery.gte('offer_percentage', percentage);
    }

    // Enhanced brand name matching with exact and fuzzy search
    const brandNames = brands.map(b => ({
      id: b.id,
      name: b.brand_name.toLowerCase(),
      words: b.brand_name.toLowerCase().split(/[\s-]+/).filter(word => word.length > 2)
    }));

    let brandMatched = false;
    const words = messageLC.split(/[\s-]+/).filter(word => word.length > 2);
    
    // First try exact brand name match
    for (const brand of brandNames) {
      if (messageLC.includes(brand.name)) {
        console.log('Exact brand match found:', brand.name);
        couponsDealsQuery = couponsDealsQuery.eq('brand_id', brand.id);
        brandMatched = true;
        break;
      }
    }
    
    // Try fuzzy matching if no exact match found
    if (!brandMatched) {
      for (const brand of brandNames) {
        const hasPartialMatch = brand.words.some(brandWord => 
          words.some(word => 
            word.includes(brandWord) || brandWord.includes(word)
          )
        );

        if (hasPartialMatch) {
          console.log('Fuzzy brand match found:', brand.name);
          couponsDealsQuery = couponsDealsQuery.eq('brand_id', brand.id);
          brandMatched = true;
          break;
        }
      }
    }

    // Add sorting by offer percentage and expiry time
    couponsDealsQuery = couponsDealsQuery
      .order('offer_percentage', { ascending: false })
      .order('expiry_time', { ascending: true });

    // Execute the query
    const { data: couponsDeals, error: couponsError } = await couponsDealsQuery;

    if (couponsError) {
      console.error('Error fetching coupons/deals:', {
        error: couponsError.message,
        details: couponsError.details,
        hint: couponsError.hint
      });
      throw new Error('Failed to fetch coupons/deals data');
    }

    console.log(`Query results: ${couponsDeals ? couponsDeals.length : 0} deals found`);
    
    if (!couponsDeals || couponsDeals.length === 0) {
      console.log('No deals found for the current query');
      console.log('Query parameters:', {
        message: message,
        brandMatched: brandMatched,
        type: messageLC.includes('coupon') ? 'coupon' : messageLC.includes('deal') ? 'deal' : 'all'
      });
      return { brands, couponsDeals: [] };
    } else {
      console.log(`Found ${couponsDeals.length} matching deals/coupons`);
      console.log('First matching deal:', {
        type: couponsDeals[0].type,
        brand: couponsDeals[0].brands?.brand_name || 'Unknown',
        title: couponsDeals[0].title,
        coupon_code: couponsDeals[0].coupon_code,
        deal_url: couponsDeals[0].deal_url,
        offer_percentage: couponsDeals[0].offer_percentage,
        expiry_time: couponsDeals[0].expiry_time
      });
      return { brands, couponsDeals };
    }
  } catch (error) {
    console.error('Error querying Supabase:', error);
    return { brands: [], couponsDeals: [] };
  }
}

// Generate AI response based on data using Gemini
async function generateAIResponse(message, data) {
  const { brands, couponsDeals } = data;
  
  // Prepare context for Gemini
  const context = {
    brands: brands.map(b => ({
      name: b.brand_name,
      id: b.id
    })),
    deals: couponsDeals.map(d => ({
      type: d.type,
      title: d.title,
      description: d.description,
      brandName: d.brands?.brand_name || 'Unknown',
      couponCode: d.coupon_code,
      dealUrl: d.deal_url,
      offerPercentage: d.offer_percentage,
      startTime: d.start_time,
      expiryTime: d.expiry_time
    }))
  };

  // Format expiry dates for deals
  context.deals = context.deals.map(deal => {
    const expiryDate = new Date(deal.expiryTime);
    deal.formattedExpiryDate = expiryDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    return deal;
  });

  // Prepare prompt for Gemini
  const prompt = `You are a helpful shopping assistant with expertise in finding the best deals and coupons. Based on the following data:

Brands: ${JSON.stringify(context.brands, null, 2)}
Deals: ${JSON.stringify(context.deals, null, 2)}

User question: ${message}

Provide a concise and natural response following these guidelines:
1. If specific deals match the query, highlight the best ones first (highest discount, soonest to expire)
2. Include specific coupon codes and expiry dates in a clear format
3. If mentioning a deal, always include the brand name and discount percentage
4. If no exact matches are found:
   - Clearly state that no exact matches were found for the specific brand/query
   - Suggest similar deals from related brands or categories
   - Recommend checking back later as deals are regularly updated
5. Keep the response friendly, informative, and focused on available deals
6. For partial matches, explain why they might be relevant to the user's query
7. If a deal has a URL, mention it's available online and can be accessed through the link

Format deals as: [Brand Name] - [Discount]% off - Code: [COUPON] (Expires: [Date])
For deals with URLs instead of codes: [Brand Name] - [Discount]% off - Available online (Expires: [Date])
Highlight any urgently expiring deals with "⚡ Ending Soon!"

If no deals are found, respond with:
"I've checked our current deals database for [brand/query]. While I don't have any active deals matching your request right now, I can suggest these alternatives: [list 2-3 best available deals from similar brands/categories]"
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Error generating Gemini response:', error);
    return 'I apologize, but I\'m having trouble processing your request at the moment. Please try again.';
  }
}

// Add coupons or deals to the database
async function addCouponOrDeal(dealData) {
  try {
    const { error } = await supabase
      .from('coupons_deals')
      .insert([dealData]);
    
    if (error) {
      console.error('Error adding coupon/deal:', error);
      return { success: false, error: error.message };
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error adding coupon/deal:', error);
    return { success: false, error: error.message };
  }
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Add routes for coupons and deals management
app.post('/api/coupons-deals', async (req, res) => {
  const { type, brand_id, coupon_code, deal_url, title, description, start_time, expiry_time, offer_percentage } = req.body;
  
  // Validate required fields
  if (!type || !brand_id || !title || !description || !start_time || !expiry_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Validate type
  if (type !== 'coupon' && type !== 'deal') {
    return res.status(400).json({ error: 'Type must be either "coupon" or "deal"' });
  }
  
  // Validate that coupon_code is provided for coupons
  if (type === 'coupon' && !coupon_code) {
    return res.status(400).json({ error: 'Coupon code is required for coupons' });
  }
  
  // Validate that deal_url is provided for deals
  if (type === 'deal' && !deal_url) {
    return res.status(400).json({ error: 'Deal URL is required for deals' });
  }
  
  // Get user session
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const dealData = {
    type,
    brand_id,
    coupon_code: type === 'coupon' ? coupon_code : null,
    deal_url: type === 'deal' ? deal_url : null,
    title,
    description,
    start_time,
    expiry_time,
    offer_percentage
  };
  
  const result = await addCouponOrDeal(dealData);
  
  if (result.success) {
    res.status(201).json({ message: 'Coupon/deal added successfully' });
  } else {
    res.status(500).json({ error: result.error });
  }
});

// Get coupons and deals
app.get('/api/coupons-deals', async (req, res) => {
  const { brand_id, type } = req.query;
  
  let query = supabase
    .from('coupons_deals')
    .select('*, brands(*)');
  
  if (brand_id) {
    query = query.eq('brand_id', brand_id);
  }
  
  if (type) {
    query = query.eq('type', type);
  }
  
  // Only return active deals
  query = query.gt('expiry_time', new Date().toISOString());
  
  // Sort by offer percentage and expiry time
  query = query
    .order('offer_percentage', { ascending: false })
    .order('expiry_time', { ascending: true });
  
  const { data, error } = await query;
  
  if (error) {
    console.error('Error fetching coupons/deals:', error);
    return res.status(500).json({ error: error.message });
  }
  
  res.json(data);
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle WebSocket connections
io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('sendMessage', async (message) => {
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      socket.emit('error', 'Please provide a valid message');
      return;
    }

    try {
      // Store message in Supabase
      const { data: messageData, error: messageError } = await supabase
        .from('messages')
        .insert([{
          content: message,
          created_at: new Date().toISOString(),
          is_ai: false
        }])
        .select();

      if (messageError) {
        console.error('Error storing user message:', {
          error: messageError.message,
          details: messageError.details,
          hint: messageError.hint
        });
        // Continue with the conversation even if message storage fails
        console.log('Continuing with conversation despite storage error');
      }

      try {
        // Query Supabase tables and generate response
        const tableData = await querySupabaseTables(message);
        const response = await generateAIResponse(message, tableData);
        
        try {
          // Store AI response
          const { error: aiResponseError } = await supabase
            .from('messages')
            .insert([{
              content: response,
              created_at: new Date().toISOString(),
              is_ai: true
            }]);

          if (aiResponseError) {
            console.error('Error storing AI response:', {
              error: aiResponseError.message,
              details: aiResponseError.details,
              hint: aiResponseError.hint
            });
          }
        } catch (storeError) {
          console.error('Error in storing AI response:', storeError);
        }

        // Always send the response to user
        socket.emit('message', response);
      } catch (processError) {
        console.error('Error processing message:', processError);
        socket.emit('error', 'I apologize, but I\'m having trouble understanding your request. Could you please rephrase it?');
      }
    } catch (error) {
      console.error('Error processing message:', error);
      socket.emit('error', 'Failed to process message');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Initialize database schema and start server
async function startServer() {
  try {
    await createStoredProcedures();
    await initializeSchema();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

startServer();