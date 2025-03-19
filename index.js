import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if environment variables are defined
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !geminiApiKey) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(geminiApiKey);
const app = express();

// Basic middleware
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
// If you're using a frontend framework with its own build directory, use this instead:
// app.use(express.static(path.join(__dirname, 'dist')));

// Properly configured CSP that allows fonts
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy", 
    "default-src 'self'; font-src 'self' data: http://localhost:* https:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'unsafe-inline';"
  );
  next();
});

async function fetchDealsFromSupabase(brand) {
  try {
    if (brand) {
      const { data: brandData, error: brandError } = await supabase
        .from('brands')
        .select('id')
        .ilike('name', `%${brand}%`)
        .single();
        
      if (brandError) {
        console.error('Brand error:', brandError);
        return { error: "Brand not found." };
      }
      
      if (!brandData) {
        return { error: "Brand not found." };
      }
      
      const { data, error } = await supabase
        .from('coupons_deals')
        .select('*')
        .eq('brand_id', brandData.id)
        .order('created_at', { ascending: false });
        
      if (error) {
        console.error('Deals error:', error);
        return { error: "Failed to fetch deals." };
      }
      
      return { data };
    } else {
      // If no brand specified, fetch all deals
      const { data, error } = await supabase
        .from('coupons_deals')
        .select('*')
        .order('created_at', { ascending: false });
        
      if (error) {
        console.error('Deals error:', error);
        return { error: "Failed to fetch deals." };
      }
      
      return { data };
    }
  } catch (err) {
    console.error('Unexpected error in fetchDealsFromSupabase:', err);
    return { error: "An unexpected error occurred." };
  }
}

// API routes
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }
  
  try {
    // Extract brand from message
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const brandExtraction = await model.generateContent(`Extract brand name and intent from: "${message}"`);
    const brandText = brandExtraction.response.text();
    const brandMatch = brandText.match(/brand:\s*(.+?)(\n|$)/i);
    const brand = brandMatch ? brandMatch[1].trim() : null;
    
    // Fetch deals
    const dealsResult = await fetchDealsFromSupabase(brand);
    
    if (dealsResult.error) {
      return res.json({ response: dealsResult.error });
    }
    
    if (!dealsResult.data || dealsResult.data.length === 0) {
      return res.json({ response: "No deals found for this brand." });
    }
    
    // Format deals for AI summary
    const dealSummary = dealsResult.data.map(d => {
      const expiry = d.expiry_time ? new Date(d.expiry_time).toLocaleDateString() : "N/A";
      return `Title: ${d.title}, Discount: ${d.offer_percentage || "N/A"}%, Expires: ${expiry}`;
    }).join("\n");
    
    // Generate summary response
    const finalResponse = await model.generateContent({
      contents: [{ text: `Summarize these deals for the user who asked: "${message}"\n\nDeals:\n${dealSummary}` }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
      }
    });
    
    res.json({ 
      message, 
      response: finalResponse.response.text(),
      dealsCount: dealsResult.data.length,
      brand
    });
    
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: "Failed to process request. Please try again later." });
  }
});

// Catch-all route for SPA frontend if you're using one
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
  // Or if using a build directory from a framework:
  // res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));