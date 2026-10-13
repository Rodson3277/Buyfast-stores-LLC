import { getDingProducts } from './server/ding';

async function testDingProducts() {
  console.log('🔍 Testing Ding API for Haiti (HT)...\n');
  
  try {
    const products = await getDingProducts('HT');
    
    console.log(`✅ Found ${products.length} Ding products for Haiti\n`);
    
    // Show first 5 products with full details
    const sample = products.slice(0, 5);
    
    sample.forEach((product: any, index: number) => {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📦 PRODUCT ${index + 1}: ${product.ProviderCode}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🏷️  SKU Code: ${product.SkuCode}`);
      console.log(`📱 Provider: ${product.ProviderCode}`);
      console.log(`📝 Display Text: ${product.DefaultDisplayText || 'N/A'}`);
      
      console.log(`\n💰 MINIMUM:`);
      console.log(`   Send: ${product.Minimum.SendCurrencyIso} ${product.Minimum.SendValue}`);
      console.log(`   Receive: ${product.Minimum.ReceiveCurrencyIso} ${product.Minimum.ReceiveValue}`);
      console.log(`   Customer Fee: ${product.Minimum.CustomerFee}`);
      
      console.log(`\n💰 MAXIMUM:`);
      console.log(`   Send: ${product.Maximum.SendCurrencyIso} ${product.Maximum.SendValue}`);
      console.log(`   Receive: ${product.Maximum.ReceiveCurrencyIso} ${product.Maximum.ReceiveValue}`);
      console.log(`   Customer Fee: ${product.Maximum.CustomerFee}`);
      
      if (product.Benefits && product.Benefits.length > 0) {
        console.log(`\n✨ BENEFITS: ${product.Benefits.join(', ')}`);
      }
      
      console.log(`\n⚙️  Processing Mode: ${product.ProcessingMode || 'N/A'}`);
      console.log(`⏰ Validity: ${product.ValidityPeriodIso || 'N/A'}`);
      
      // Show how it converts to bundle format
      const bundle = {
        id: `ding_${product.SkuCode}`,
        operatorId: `ding_${product.ProviderCode}`,
        name: `${product.Minimum.SendCurrencyIso} ${product.Minimum.SendValue}-${product.Maximum.SendValue}`,
        price: product.Minimum.SendValue,
        maxAmount: product.Maximum.SendValue,
        currency: product.Minimum.SendCurrencyIso,
        type: 'DING_BUNDLE'
      };
      
      console.log(`\n🔄 CONVERTED TO BUNDLE:`);
      console.log(JSON.stringify(bundle, null, 2));
    });
    
    // Group by provider
    console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 SUMMARY BY PROVIDER`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    const byProvider = products.reduce((acc: any, p: any) => {
      acc[p.ProviderCode] = (acc[p.ProviderCode] || 0) + 1;
      return acc;
    }, {});
    
    Object.entries(byProvider).forEach(([provider, count]) => {
      console.log(`${provider}: ${count} products`);
    });
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

testDingProducts();
