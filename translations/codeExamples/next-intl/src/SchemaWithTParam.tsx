// Test case for Pattern 1: Function with 't' parameter (schema pattern)
// This pattern is commonly used with form validation libraries like Zod

import { z } from 'zod';
import { useTranslations } from 'next-intl';

// Schema function that accepts 't' translator as parameter
export const myFormSchema = (t: (key: string) => string) =>
  z.object({
    title: z.string().min(1, t('title_required')),
    email: z.string().email(t('email_invalid')),
    name: z.string().min(1, t('name_required')),
  });

// Usage in component
export function MyForm() {
  const t = useTranslations('FormErrors');

  // Schema called with translator from useTranslations
  const schema = myFormSchema(t);

  return <div>Form</div>;
}

// Another example with different namespace
export const loginSchema = (t: (key: string) => string) =>
  z.object({
    username: z.string().min(1, t('username_required')),
    password: z.string().min(6, t('password_too_short')),
  });

export function LoginForm() {
  const t = useTranslations('Login');
  const schema = loginSchema(t);

  return <div>Login</div>;
}
