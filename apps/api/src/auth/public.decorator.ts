import { SetMetadata } from '@nestjs/common';

// Σημαδεύει routes που παρακάμπτουν το global JwtAuthGuard: το login (δεν
// υπάρχει ακόμα token) και το sync (δικό του guard, static token ανά server).
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
