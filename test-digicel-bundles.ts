import { ReloadlyService } from './server/services/reloadly';

async function testDigicelBundles() {
  console.log('🔍 Testing Digicel Haiti bundles...\n');
  
  try {
    const reloadly = new ReloadlyService();
    
    // Get operators for Haiti
    const operators = await reloadly.getOperators('HT');
    console.log(`Found ${operators.length} operators for Haiti\n`);
    
    // Find Digicel
    const digicel = operators.find((op: any) => op.name?.toLowerCase().includes('digicel'));
    
    if (digicel) {
      console.log(`✅ Found Digicel: ${digicel.name} (ID: ${digicel.operatorId})\n`);
      
      // Get bundles
      const bundles = await reloadly.getDataBundles(digicel.operatorId);
      
      console.log(`📦 Found ${bundles.length} bundles for Digicel\n`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      // Show first 5 bundles
      bundles.slice(0, 5).forEach((bundle: any, index: number) => {
        console.log(`Bundle ${index + 1}:`);
        console.log(`  Name: ${bundle.name}`);
        console.log(`  Description: ${bundle.description || 'NO DESCRIPTION'}`);
        console.log(`  Price: ${bundle.price} ${bundle.currency}`);
        console.log(`  Amount: ${bundle.amount}`);
        console.log(`  Validity: ${bundle.validity || 'N/A'}`);
        console.log('');
      });
    } else {
      console.log('❌ Digicel not found');
    }
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

testDigicelBundles();
