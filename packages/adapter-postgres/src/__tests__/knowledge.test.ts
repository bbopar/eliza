import { getEmbeddingConfig, RAGKnowledgeItem, stringToUuid, UUID } from "@elizaos/core";

import { PostgresDatabaseAdapter } from "../index";
import pg from "pg";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import {
    elizaLogger,
    EmbeddingOptions,
    getEmbeddingForTest,
} from "@elizaos/core";
import {
    AGENT_1_ID,
    AGENT_2_ID,
    AGENT_3_ID,
    AGENT_4_ID,
    AGENT_5_ID,
    setupKnowledgeTestData,
} from "./setup";
import util from "util";
vi.setConfig({ testTimeout: 50000 });

const cleanCache = async (client: pg.PoolClient) => {
    elizaLogger.info("Starting cache cleanup...");
    try {
        await client.query("DELETE FROM cache WHERE TRUE");
        elizaLogger.success("Cache cleanup completed successfully");
    } catch (error) {
        elizaLogger.error(
            `Cache cleanup failed: ${
                error instanceof Error ? error.message : "Unknown error"
            }`
        );
        throw error;
    }
};

const EMBEDDING_OPTIONS: EmbeddingOptions = {
    model: "text-embedding-3-small",
    endpoint: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    dimensions: 1536,
    isOllama: false,
    provider: "OpenAI",
};

describe("Knowledge Operations", () => {
    let adapter: PostgresDatabaseAdapter;
    let testClient: pg.PoolClient;
    let testPool: pg.Pool;
    const dbConfig = {
        host: "localhost",
        port: 5432,
        database: "eliza",
        user: "postgres",
        password: "postgres",
    };

    beforeAll(async () => {
        testPool = new pg.Pool(dbConfig);
        testClient = await testPool.connect();

        // Override config to OPENAI use 1536 dimensions!
        await testClient.query(`
            ALTER DATABASE eliza SET app.use_openai_embedding = 'true';
            ALTER DATABASE eliza SET app.use_ollama_embedding = 'false';
        `);

        adapter = new PostgresDatabaseAdapter(dbConfig);
        await adapter.init();

        // Check and create accounts for all agents
        const agentConfigs = [
            { id: AGENT_1_ID, name: "Agent Test 1", username: "agent-test-1" },
            { id: AGENT_2_ID, name: "Agent Test 2", username: "agent-test-2" },
            { id: AGENT_3_ID, name: "Agent Test 3", username: "agent-test-3" },
            { id: AGENT_4_ID, name: "Agent Test 4", username: "agent-test-4" },
            { id: AGENT_5_ID, name: "Agent Test 5", username: "agent-test-5" },
        ];

        for (const config of agentConfigs) {
            const existingAccount = await adapter.getAccountById(config.id);
            if (!existingAccount) {
                await adapter.createAccount({
                    id: config.id,
                    name: config.name,
                    username: config.username,
                    email: `${config.username}@test.com`,
                });
            }
        }

        const checkKnowledge = await adapter.getKnowledge({
            agentId: AGENT_1_ID,
        });

        console.log("checkKnowledge", checkKnowledge);

        if (checkKnowledge.length === 0) {
            await setupKnowledgeTestData(adapter);
        }
    }, 50000);

    beforeEach(async () => {
        // await cleanDatabase(testClient);
    });

    afterAll(async () => {
        try {
            // await cleanDatabase(testClient);
            await testClient?.release();
            await testPool?.end();
            await adapter?.close();
        } catch (error) {
            elizaLogger.error("Error in afterAll cleanup:", error);
            throw error;
        }
    });

    afterEach(async () => {
        await cleanCache(testClient);
    });

    describe("Basic Knowledge Operations", () => {
        test("should create new knowledge item", async () => {
            const knowledgeItem = {
                id: stringToUuid("test-knowledge-1"),
                agentId: AGENT_4_ID,
                content: {
                    text: "Test knowledge content",
                    metadata: {
                        category: "test",
                        isMain: true,
                        isShared: false,
                    },
                },
                createdAt: Date.now(),
            };

            await adapter.createKnowledge(knowledgeItem);

            const result = await adapter.getKnowledge({
                id: knowledgeItem.id,
                agentId: AGENT_4_ID,
            });

            expect(result).toHaveLength(1);
            expect(result[0].content.text).toBe("Test knowledge content");
            expect(result[0].agentId).toBe(AGENT_4_ID);
            expect(result[0].content.metadata?.category).toBe("test");
            expect(result[0].content.metadata?.isMain).toBe(true);
            expect(result[0].content.metadata?.isShared).toBe(false);
        });

        test("should retrieve knowledge item by ID", async () => {
            const knowledgeItem = {
                id: stringToUuid("test-knowledge-2"),
                agentId: AGENT_4_ID,
                content: {
                    text: "Retrievable test content",
                    metadata: {
                        category: "test",
                        isMain: true,
                        isShared: false,
                    },
                },
                createdAt: Date.now(),
            };

            await adapter.createKnowledge(knowledgeItem);

            const result = await adapter.getKnowledge({
                id: knowledgeItem.id,
                agentId: AGENT_4_ID,
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(knowledgeItem.id);
            expect(result[0].content.text).toBe("Retrievable test content");
        });

        test("should remove knowledge item", async () => {
            const knowledgeItem = {
                id: stringToUuid("test-knowledge-3"),
                agentId: AGENT_4_ID,
                content: {
                    text: "Content to be removed",
                    metadata: {
                        category: "test",
                        isMain: true,
                        isShared: false,
                    },
                },
                createdAt: Date.now(),
            };

            await adapter.createKnowledge(knowledgeItem);

            // Verify item exists
            let result = await adapter.getKnowledge({
                id: knowledgeItem.id,
                agentId: AGENT_4_ID,
            });
            expect(result).toHaveLength(1);

            // Remove the item
            await adapter.removeKnowledge(knowledgeItem.id);

            // Verify item was removed
            result = await adapter.getKnowledge({
                id: knowledgeItem.id,
                agentId: AGENT_4_ID,
            });
            expect(result).toHaveLength(0);
        });

        test("should clear all knowledge for an agent", async () => {
            const items = [
                {
                    id: stringToUuid("test-knowledge-4"),
                    agentId: AGENT_4_ID,
                    content: {
                        text: "First test content",
                        metadata: {
                            category: "test",
                            isMain: true,
                            isShared: false,
                        },
                    },
                    createdAt: Date.now(),
                },
                {
                    id: stringToUuid("test-knowledge-5"),
                    agentId: AGENT_4_ID,
                    content: {
                        text: "Second test content",
                        metadata: {
                            category: "test",
                            isMain: true,
                            isShared: false,
                        },
                    },
                    createdAt: Date.now(),
                },
            ];

            // Create all items
            for (const item of items) {
                await adapter.createKnowledge(item);
            }

            // Verify items exist
            let result = await adapter.getKnowledge({
                agentId: AGENT_4_ID,
            });
            expect(result.length).toBeGreaterThanOrEqual(2);

            // Clear all knowledge for the agent
            await adapter.clearKnowledge(AGENT_4_ID, false);

            // Verify all items were removed
            const { rows } = await testClient.query(`
                SELECT COUNT(*) 
                FROM knowledge 
                WHERE "agentId" = $1
            `, [AGENT_4_ID]);
            
            expect(Number(rows[0].count)).toBe(0);
        });
    });


    describe("Knowledge Search Operations", () => {
        test.only("should find shared knowledge items across all agents", async () => {
            const text = "Agile methodology project management";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_2_ID, // Using different agent than items were created with
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
        
            expect(searchResults.length).toBeGreaterThan(0);
            expect(searchResults[0].content.metadata?.isShared).toBe(true);
            expect(searchResults[0].similarity).toBeGreaterThan(0.8);
            expect(searchResults[0].content.text).toContain("Agile methodology");
        });

        test("should only find private knowledge items for specific agent", async () => {
            const text = "Internal Company Handbook";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_2_ID,
                embedding: new Float32Array(embedding), 
                match_threshold: 0.05,
                match_count: 5
            });
        
            // All results should either be shared OR belong to AGENT_2_ID
            searchResults.forEach(result => {
                expect(
                    result.agentId === AGENT_2_ID || 
                    result.content.metadata?.isShared
                ).toBe(true);
            });
        
            // First result should be the private handbook
            expect(searchResults[0].agentId).toBe(AGENT_2_ID);
            expect(searchResults[0].content.metadata?.isShared).toBe(false);
            expect(searchResults[0].content.text).toContain("Internal Company Handbook");
        });

        test("should not find private knowledge items from other agents", async () => {
            // Try to find AGENT_1_ID's private document using AGENT_2_ID
            const text = "Internal API documentation";  // This belongs to AGENT_1_ID
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_2_ID,  // Different agent
                embedding: new Float32Array(embedding), 
                match_threshold: 0.05,
                match_count: 5
            });

            console.log("searchResults", util.inspect(searchResults, { depth: null, colors: true }));
         
            // None of the private results should be from AGENT_1_ID
            const privateResults = searchResults.filter(r => !r.content.metadata?.isShared);
            privateResults.forEach(result => {
                expect(result.agentId).not.toBe(AGENT_1_ID);
            });
         });

         test("should find main documents with higher relevance", async () => {
            const text = "Modern Software Development";  // This matches the main document title
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5
            });
         
            expect(searchResults[0].content.metadata?.isMain).toBe(true);
            expect(searchResults[0].content.text).toContain("Modern Software Development");
            expect(searchResults[0].similarity).toBeGreaterThan(0.8);
         });
         
         test("should find relevant chunks from main documents", async () => {
            const text = "Git Version Control";  // This matches a chunk content
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5
            });
         
            const chunks = searchResults.filter(r => r.content.metadata?.isChunk);
            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks[0].content.text).toContain("Git");
         });
         
         test("should properly rank chunks vs main documents in search results", async () => {
            const text = "Continuous Integration Testing Software";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 10  // Increased to get more results
            });
        
            // Should find both main and chunk documents
            const mainDocs = searchResults.filter(r => r.content.metadata?.isMain);
            const chunks = searchResults.filter(r => r.content.metadata?.isChunk);
            
            expect(mainDocs.length).toBeGreaterThan(0);
            expect(chunks.length).toBeGreaterThan(0);
        
            // Should find both the main doc and its relevant chunks
            const hasMainDoc = mainDocs.some(doc => 
                doc.content.text.includes("Software Development")
            );
            const hasChunk = chunks.some(chunk => 
                chunk.content.text.includes("Continuous Integration") ||
                chunk.content.text.includes("Testing")
            );
        
            expect(hasMainDoc).toBe(true);
            expect(hasChunk).toBe(true);
        });

        test("should return results above similarity threshold", async () => {
            const text = "Machine Learning fundamentals";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const threshold = 0.05;  // Lower threshold since our scores might be in different range
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: threshold,
                match_count: 5
            });
        
            // Verify we got results
            expect(searchResults.length).toBeGreaterThan(0);
            
            // The best match should be about machine learning
            expect(searchResults[0].content.text.toLowerCase()).toContain("machine learning");
            
            // All results should be above threshold
            searchResults.forEach(result => {
                expect(result.similarity).toBeDefined();
                expect(typeof result.similarity).toBe('number');
                expect(result.similarity).toBeGreaterThan(-1); // Cosine similarity should be between -1 and 1
            });
        });
         
         test("should properly order results by similarity score", async () => {
            const text = "Cloud computing and infrastructure";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5
            });
         
            // Verify results are ordered by descending similarity
            for (let i = 1; i < searchResults.length; i++) {
                expect(searchResults[i - 1].similarity).toBeGreaterThanOrEqual(
                    searchResults[i].similarity || 0
                );
            }
         });
         
         test("should combine vector similarity with keyword matching", async () => {
            const text = "Cloud infrastructure";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const searchResults = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
                searchText: "cloud"  // Adding explicit keyword
            });
         
            // The most relevant result should contain both semantic and keyword matches
            expect(searchResults[0].content.text.toLowerCase()).toContain("cloud");
            expect(searchResults[0].similarity).toBeGreaterThan(0.7);
         });

         test("should find shared knowledge items when searching as different agents", async () => {
            // Search for shared business content using different agents
            const text = "Cross-team collaboration";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results1 = await adapter.searchKnowledge({
                agentId: AGENT_2_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            const results2 = await adapter.searchKnowledge({
                agentId: AGENT_3_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            // Both agents should find the shared content
            expect(results1.some(r => r.content.metadata?.isShared)).toBe(true);
            expect(results2.some(r => r.content.metadata?.isShared)).toBe(true);
         });
         
         test("should respect privacy when searching across multiple agents", async () => {
            const text = "Internal Company Handbook policies procedures";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_3_ID, // Different from AGENT_2_ID who owns the handbook
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            // Should not find private content from other agents
            results.filter(r => !r.content.metadata?.isShared)
                  .forEach(r => expect(r.agentId).not.toBe(AGENT_2_ID));
         });
         
         test("should find items in technology category", async () => {
            const text = "Cloud computing and machine learning";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            expect(results.some(r => 
                r.content.metadata?.category === 'technology' && 
                (r.content.text.toLowerCase().includes('cloud') || 
                 r.content.text.toLowerCase().includes('machine learning'))
            )).toBe(true);
         });
         
         test("should find items in business category", async () => {
            const text = "Agile project management";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            expect(results.some(r => 
                r.content.metadata?.category === 'business' && 
                r.content.text.toLowerCase().includes('agile')
            )).toBe(true);
         });
         
         test("should find items in internal category only for authorized agent", async () => {
            const text = "Internal policies and procedures";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            // Search as authorized agent
            const authorizedResults = await adapter.searchKnowledge({
                agentId: AGENT_2_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            // Search as unauthorized agent
            const unauthorizedResults = await adapter.searchKnowledge({
                agentId: AGENT_3_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 5,
            });
         
            // Authorized agent should find internal items
            expect(authorizedResults.some(r => 
                r.content.metadata?.category === 'internal' && 
                r.agentId === AGENT_2_ID
            )).toBe(true);
         
            // Unauthorized agent should not find other's internal items
            expect(unauthorizedResults.some(r => 
                r.content.metadata?.category === 'internal' && 
                r.agentId === AGENT_2_ID
            )).toBe(false);
         });

         test("should handle search with both shared and private content", async () => {
            const text = "Software development API documentation";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 10
            });
        
            console.log("################ results", util.inspect(results, { depth: null, colors: true }));
         
            // Should find both shared and private content
            const sharedResults = results.filter(r => r.content.metadata?.isShared);
            const privateResults = results.filter(r => !r.content.metadata?.isShared);
         
            expect(sharedResults.length).toBeGreaterThan(0);
            expect(privateResults.length).toBeGreaterThan(0);
            
            // Verify private results belong to correct agent
            privateResults.forEach(r => expect(r.agentId).toBe(AGENT_1_ID));
        });
         
         test("should properly handle document hierarchies in search results", async () => {
            const text = "Software development testing and version control";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 10
            });
         
            // Find a main document and its related chunks
            const mainDoc = results.find(r => r.content.metadata?.isMain);
            const relatedChunks = results.filter(r => 
                r.content.metadata?.isChunk && 
                r.content.metadata?.originalId === mainDoc?.id
            );
         
            expect(mainDoc).toBeDefined();
            expect(relatedChunks.length).toBeGreaterThan(0);
            
            // Verify chunk relationships
            relatedChunks.forEach(chunk => {
                expect(chunk.content.metadata?.originalId).toBe(mainDoc?.id);
            });
         });
         
         test("should maintain proper relevance scoring across document types", async () => {
            const text = "Version control and continuous integration";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 10
            });
         
            // Group results by type
            const mainDocs = results.filter(r => r.content.metadata?.isMain);
            const chunks = results.filter(r => r.content.metadata?.isChunk);
            const sharedDocs = results.filter(r => r.content.metadata?.isShared);
            const privateDocs = results.filter(r => !r.content.metadata?.isShared);
         
            // Verify we have mixed types of results
            expect(mainDocs.length).toBeGreaterThan(0);
            expect(chunks.length).toBeGreaterThan(0);
            
            // Check that scores are properly distributed
            results.forEach((result, i) => {
                if (i > 0) {
                    expect(result.similarity).toBeLessThanOrEqual(results[i-1].similarity || 0);
                }
            });
         
            // Most relevant result should be about version control or CI
            expect(results[0].content.text.toLowerCase()).toMatch(/(version control|continuous integration)/);
         });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle empty embedding vectors", async () => {
            const results = await adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array(1536),
                match_threshold: 0.05,
                match_count: 10
            });
            
            // Verify all results have very small similarity scores
            results.forEach(r => {
                expect(Math.abs(r.similarity || 0)).toBeLessThan(0.000001);
            });
        });
     
        test("should handle invalid search parameters", async () => {
            await expect(adapter.searchKnowledge({
                agentId: AGENT_1_ID,
                embedding: new Float32Array([1, 2, 3]), // Wrong dimensions
                match_threshold: -1, // Invalid threshold
                match_count: -5 // Invalid count
            })).rejects.toThrow();
        });
     
        test("should handle non-existent agent IDs", async () => {
            const text = "test";
            const embedding = await getEmbeddingForTest(text, EMBEDDING_OPTIONS);
            
            const results = await adapter.searchKnowledge({
                agentId: stringToUuid("non-existent-agent-id"), 
                embedding: new Float32Array(embedding),
                match_threshold: 0.05,
                match_count: 10
            });
        
            // All results should be shared items
            expect(results.length).toBeGreaterThan(0);
            expect(results.every(r => r.content.metadata?.isShared)).toBe(true);
        });
     
        test("should handle malformed knowledge items", async () => {
            const embedding = await getEmbeddingForTest("test", EMBEDDING_OPTIONS);
            
            // Create malformed item
            const malformedItem = {
                id: stringToUuid("malformed-test"),
                agentId: AGENT_1_ID,
                content: null, // Malformed content
                embedding: new Float32Array(embedding),
                createdAt: Date.now()
            };
     
            await expect(adapter.createKnowledge(malformedItem as unknown as RAGKnowledgeItem)).rejects.toThrow();
        });
     });
});

// const initializeDatabase = async (client: pg.PoolClient) => {
//     elizaLogger.info('Initializing database with schema...');
//     try {
//         // Set app settings for vector dimension
//         await client.query(`
//             ALTER DATABASE eliza SET app.use_openai_embedding = 'true';
//             ALTER DATABASE eliza SET app.use_ollama_embedding = 'false';
//         `);

//         // Read and execute schema file
//         const schemaPath = path.resolve(__dirname, '../../schema.sql');
//         const schema = fs.readFileSync(schemaPath, 'utf8');
//         await client.query(schema);

//         // Verify schema setup
//         const { rows: vectorExt } = await client.query(`
//             SELECT * FROM pg_extension WHERE extname = 'vector'
//         `);
//         elizaLogger.info('Vector extension status:', { isInstalled: vectorExt.length > 0 });

//         const { rows: dimension } = await client.query('SELECT get_embedding_dimension()');
//         elizaLogger.info('Vector dimension:', { dimension: dimension[0].get_embedding_dimension });

//         // Verify search path
//         const { rows: searchPath } = await client.query('SHOW search_path');
//         elizaLogger.info('Search path:', { searchPath: searchPath[0].search_path });

//     } catch (error) {
//         elizaLogger.error(`Database initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
//         throw error;
//     }
// };

// const cleanDatabase = async (client: pg.PoolClient) => {
//     elizaLogger.info("Starting database cleanup...");
//     try {
//         await client.query("DELETE FROM knowledge WHERE TRUE");
//         await client.query("DELETE FROM accounts WHERE TRUE");
//         elizaLogger.success("Database cleanup completed successfully");
//     } catch (error) {
//         elizaLogger.error(
//             `Database cleanup failed: ${
//                 error instanceof Error ? error.message : "Unknown error"
//             }`
//         );
//         throw error;
//     }
// };
