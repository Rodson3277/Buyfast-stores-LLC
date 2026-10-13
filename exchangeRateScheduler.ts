import * as cron from 'node-cron';
import exchangeRateService from '../services/exchangeRateService';

// Cron job for updating exchange rates daily
// Schedule: 0 2 * * * (Daily at 2 AM)
let exchangeRateCronJob: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start the exchange rate update cron job
 */
export function startExchangeRateScheduler(): void {
  if (exchangeRateCronJob) {
    console.log('⚠️ Exchange rate scheduler already running');
    return;
  }

  console.log('💱 Starting exchange rate scheduler - daily at 2 AM');

  // Schedule: Daily at 2 AM
  exchangeRateCronJob = cron.schedule('0 2 * * *', async () => {
    console.log('💱 Exchange Rate Cron Job: Starting daily update...');
    
    try {
      // Update all exchange rates from API
      const updatedCount = await exchangeRateService.updateExchangeRates();

      console.log('✅ Exchange Rate Cron Job completed:', {
        updatedCount,
        time: new Date().toISOString()
      });

    } catch (error: any) {
      console.error('❌ Exchange Rate Cron Job failed:', error);
    }
  });

  console.log('✅ Exchange rate scheduler started - updating daily at 2 AM');
}

/**
 * Stop the exchange rate cron job
 */
export function stopExchangeRateScheduler(): void {
  if (exchangeRateCronJob) {
    exchangeRateCronJob.stop();
    exchangeRateCronJob.destroy();
    exchangeRateCronJob = null;
    console.log('🛑 Exchange rate scheduler stopped');
  }
}

/**
 * Manually trigger exchange rate update (for admin use)
 */
export async function triggerManualExchangeRateUpdate(): Promise<any> {
  console.log('🧪 Manual exchange rate update triggered');
  
  try {
    const updatedCount = await exchangeRateService.updateExchangeRates();

    console.log('✅ Manual exchange rate update completed:', {
      updatedCount,
      time: new Date().toISOString()
    });

    return {
      success: true,
      updatedCount,
      message: `Successfully updated ${updatedCount} exchange rates`,
      timestamp: new Date().toISOString()
    };

  } catch (error: any) {
    console.error('❌ Manual exchange rate update failed:', error);
    return {
      success: false,
      updatedCount: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get exchange rate scheduler status
 */
export function getExchangeRateSchedulerStatus(): { running: boolean; nextRun?: string } {
  if (!exchangeRateCronJob) {
    return { running: false };
  }

  return {
    running: true,
    nextRun: exchangeRateCronJob.nextDate()?.toISOString()
  };
}

export default {
  startExchangeRateScheduler,
  stopExchangeRateScheduler,
  triggerManualExchangeRateUpdate,
  getExchangeRateSchedulerStatus
};
