import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rota.app',
  appName: 'Rota',
  webDir: 'www',
  server: {
    url: 'https://rota-lovat-gamma.vercel.app/',
    cleartext: false,
    androidScheme: 'https',
  },
};

export default config;
