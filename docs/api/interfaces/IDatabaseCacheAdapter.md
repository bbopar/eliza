[@elizaos/core v0.1.7](../index.md) / IDatabaseCacheAdapter

# Interface: IDatabaseCacheAdapter

## Methods

### getCache()

> **getCache**(`params`): `Promise`\<`string`\>

#### Parameters

• **params**

• **params.agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.key**: `string`

#### Returns

`Promise`\<`string`\>

#### Defined in

[packages/core/src/types.ts:1008](https://github.com/bbopar/eliza/blob/main/packages/core/src/types.ts#L1008)

***

### setCache()

> **setCache**(`params`): `Promise`\<`boolean`\>

#### Parameters

• **params**

• **params.agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.key**: `string`

• **params.value**: `string`

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[packages/core/src/types.ts:1013](https://github.com/bbopar/eliza/blob/main/packages/core/src/types.ts#L1013)

***

### deleteCache()

> **deleteCache**(`params`): `Promise`\<`boolean`\>

#### Parameters

• **params**

• **params.agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.key**: `string`

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[packages/core/src/types.ts:1019](https://github.com/bbopar/eliza/blob/main/packages/core/src/types.ts#L1019)
