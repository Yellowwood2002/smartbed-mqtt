import { readFileSync } from 'fs';
import { optionsSchema } from './options.schema';
import { logError } from './logger';
import { z } from 'zod';

export type Type =
  | 'sleeptracker'
  | 'ergomotion'
  | 'ergowifi'
  | 'richmat'
  | 'linak'
  | 'solace'
  | 'motosleep'
  | 'reverie'
  | 'leggettplatt'
  | 'logicdata'
  | 'okimat'
  | 'keeson'
  | 'octo'
  | 'scanner';

let options: z.infer<typeof optionsSchema>;

try {
  const fileContents = readFileSync('../data/options.json');
  const optionsJson = JSON.parse(fileContents.toString());
  options = optionsSchema.parse(optionsJson);
} catch (error) {
  if (error instanceof z.ZodError) {
    logError('Error validating options.json:');
    for (const issue of error.issues) {
      logError(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    logError('Error reading or parsing options.json:', error);
  }
  process.exit(1);
}

export const getRootOptions = (): any => options;

export const getType = () => options.type;
