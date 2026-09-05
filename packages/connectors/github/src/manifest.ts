// Tool names, schemas, trace labels, and the explicit `requiresApproval` flag.
// Safe for the runtime to import: contains no credential and no execution path.
//
// requiresApproval is declared metadata, never inferred from HTTP verb or tool name —
// POST can be a read-only search and GET can be sensitive. The rule for setting it is
// identity, not danger: acting as the bot is autonomous, acting as the invoker is not.

export {};
