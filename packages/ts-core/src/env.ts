/**
 * Environment variable validation
 */

export interface EnvSchema {
  [key: string]: {
    required?: boolean;
    default?: string;
    validate?: (value: string) => boolean;
  };
}

export class EnvValidator {
  static validate<T extends Record<string, string>>(
    env: any,
    schema: EnvSchema
  ): T {
    const validated: any = {};
    const errors: string[] = [];

    for (const [key, config] of Object.entries(schema)) {
      const value = env[key];

      if (!value || value === '') {
        if (config.required) {
          errors.push(`Missing required environment variable: ${key}`);
        } else if (config.default) {
          validated[key] = config.default;
        }
        continue;
      }

      if (config.validate && !config.validate(value)) {
        errors.push(`Invalid value for environment variable: ${key}`);
        continue;
      }

      validated[key] = value;
    }

    if (errors.length > 0) {
      throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
    }

    return validated as T;
  }
}

/**
 * Validate required environment variables
 */
export function validateEnv(env: any, required: string[]): void {
  const missing = required.filter((key) => !env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
