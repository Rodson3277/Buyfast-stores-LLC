import { reviewKYCDocument } from './server/kyc-verification';

async function testKYCNotification() {
  console.log('🧪 TESTING KYC NOTIFICATION SYSTEM');
  console.log('===================================\n');

  const verificationId = '736973a1-4dd7-4eed-b6da-61fb544e35d2';
  const adminId = 'restored_admin_rodson'; // Owner account ID
  
  console.log('📧 User: poli@gmail.com (POLI VALAN)');
  console.log('📱 Phone: 12345678');
  console.log('🌍 Language: English (en)');
  console.log('📋 Verification ID:', verificationId);
  console.log('\n🔔 ACTION: Requesting additional information...\n');

  try {
    const result = await reviewKYCDocument(
      verificationId,
      adminId,
      'request_info',
      {
        requestedInfo: "Please provide a clearer photo of your driver's license. The current image is blurry and we cannot verify the details. Also include a selfie holding your ID.",
        notes: "Document quality is poor - need better resolution"
      }
    );

    console.log('\n✅ RESULT:', result);
    console.log('\n📧 Check the logs above for:');
    console.log('  - Email notification sent');
    console.log('  - SMS notification sent');
    console.log('  - Push notification sent');
    console.log('\n🎯 Now check MonCash/NatCash pages for "Resubmit Documents" button!');
  } catch (error) {
    console.error('❌ ERROR:', error);
  }
}

testKYCNotification();
