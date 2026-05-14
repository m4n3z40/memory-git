import mri from 'mri';
import type { Command } from './types.js';

const config: Command = {
    names: ['config'],
    async run({ mg }, args) {
        const a = mri(args);
        const [key, value] = a._.map(String);
        if (!key) throw new Error('error: key required');
        const result = await mg.config(key, value || undefined);
        return result ?? '';
    },
};

export default config;
