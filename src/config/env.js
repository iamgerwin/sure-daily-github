import dotenv from 'dotenv';

// Loads .env into process.env. Imported for its side effect by every module
// that reads the environment while it is being imported: ES modules evaluate
// their imports first, so a .env loaded later (e.g. by the config loader) would
// miss settings such as SDG_STATE_FILE that the state singleton reads on import
dotenv.config();
