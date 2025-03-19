import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to format deals for display
function formatDeal(deal) {
  const expiryDate = new Date(deal.expiry_time).toLocaleDateString();
  const brandName = deal.brands?.brand_name || 'Unknown Brand';
  const discount = deal.offer_percentage ? `${deal.offer_percentage}% off` : 'Special offer';
  
  if (deal.type === 'coupon') {
    return `${brandName}: ${discount} - Use code: ${deal.coupon_code} (Expires: ${expiryDate})`;
  } else {
    return `${brandName}: ${discount} - Check deal online (Expires: ${expiryDate})`;
  }
}

// Query Supabase for deals
async function queryDeals(message) {
  try {
    console.log('Querying deals for:', message);
    
    // Get all brands first
    const { data: brands } = await supabase
      .from('brands')
      .select('id, brand_name');
    
    // Get all active deals with brand information
    const { data: deals, error } = await supabase
      .from('coupons_deals')
      .select(`
        *,
        brands (
          id,
          brand_name
        )
      `)
      .gt('expiry_time', new Date().toISOString());
    
    if (error) {
      console.error('Error fetching deals:', error);
      return { deals: [], brands: [] };
    }

    console.log(`Found ${deals.length} active deals`);
    
    // Filter and sort deals
    const messageLC = message.toLowerCase();
    let filteredDeals = deals;
    
    // Filter by brand if mentioned
    const mentionedBrand = brands.find(brand => 
      messageLC.includes(brand.brand_name.toLowerCase())
    );
    
    if (mentionedBrand) {
      filteredDeals = filteredDeals.filter(deal => deal.brand_id === mentionedBrand.id);
    }
    
    // Filter by type
    if (messageLC.includes('coupon')) {
      filteredDeals = filteredDeals.filter(deal => deal.type === 'coupon');
    } else if (messageLC.includes('deal')) {
      filteredDeals = filteredDeals.filter(deal => deal.type === 'deal');
    }
    
    // Sort by discount percentage and expiry
    filteredDeals.sort((a, b) => {
      if (a.offer_percentage !== b.offer_percentage) {
        return b.offer_percentage - a.offer_percentage;
      }
      return new Date(a.expiry_time) - new Date(b.expiry_time);
    });

    return {
      deals: filteredDeals,
      brands,
      totalDeals: deals.length
    };
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Generate AI response
async function generateResponse(message, data) {
  try {
    const { deals, brands, totalDeals } = data;
    
    if (deals.length === 0) {
      const brandSuggestions = brands
        .slice(0, 3)
        .map(b => b.brand_name)
        .join(', ');
      
      return `I've checked our database of ${totalDeals} active deals. While I don't have exact matches for your request, here are some suggestions:

1. Try searching for specific brands like ${brandSuggestions}
2. Ask for "all deals" or "all coupons"
3. Specify a discount amount (e.g., "50% off deals")

How can I help you find the right deal?`;
    }

    const prompt = `As a shopping assistant, help the user who asked: "${message}"

Available Deals:
${deals.map(deal => formatDeal(deal)).join('\n')}

Create a friendly, concise response that:
1. Highlights the best deals (highest discount first)
2. Includes specific coupon codes and expiry dates
3. Suggests related deals if available
4. Keeps the tone helpful and enthusiastic

Response:`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error('AI generation error:', error);
    throw error;
  }
}

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('sendMessage', async (message) => {
    try {
      // Log incoming message
      console.log('Received message:', message);

      // Query deals from database
      const data = await queryDeals(message);
      console.log(`Found ${data.deals.length} matching deals`);

      // Generate AI response
      const response = await generateResponse(message, data);
      
      // Send response back to client
      socket.emit('message', response);
      
      // Store conversation in database
      await supabase.from('messages').insert([
        { content: message, is_ai: false },
        { content: response, is_ai: true }
      ]);
      
    } catch (error) {
      console.error('Error processing message:', error);
      socket.emit('error', 'Sorry, I encountered an error while processing your request. Please try again.');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});