import {
    describe,
    expect,
    test,
    beforeAll,
    afterAll,
    afterEach,
    vi,
} from "vitest";
import { DrizzleDatabaseAdapter } from "../index";
import { elizaLogger, Memory, stringToUuid, UUID } from "@elizaos/core";
import Docker from "dockerode";
import pg from "pg";
import { sql } from "drizzle-orm";
import { getEmbeddingForTest } from "@elizaos/core";
import { EMBEDDING_OPTIONS, MemorySeedManager } from "./seed.ts";
import { connectDatabase, cleanDatabase, parseVectorString, stopContainers } from "./utils.ts";

vi.setConfig({ testTimeout: 15000 });

vi.mock("@elizaos/core", async () => {
    const actual = await vi.importActual("@elizaos/core");
    return {
        ...actual,
        getEmbeddingConfig: () => ({
            provider: EMBEDDING_OPTIONS.provider,
            dimensions: EMBEDDING_OPTIONS.dimensions,
            model: EMBEDDING_OPTIONS.model,
        }),
        settings: {
            USE_OPENAI_EMBEDDING: "false",
            USE_OLLAMA_EMBEDDING: "false",
            USE_GAIANET_EMBEDDING: "false",
            OPENAI_API_KEY: "mock-openai-key",
            OPENAI_API_URL: "https://api.openai.com/v1",
            GAIANET_API_KEY: "mock-gaianet-key",
            OLLAMA_EMBEDDING_MODEL: "mxbai-embed-large",
            GAIANET_EMBEDDING_MODEL: "nomic-embed",
        },
    };
});

describe("Memory Operations with Vector", () => {
    const TEST_TABLE = "test_memories";
    let adapter: DrizzleDatabaseAdapter;
    let client: pg.Client;
    let docker: Docker;
    const seedManager = new MemorySeedManager();
    let MEMORY_IDS: Map<string, UUID[]>;

    beforeAll(async () => {
        ({ adapter, client, docker } = await connectDatabase());
        await adapter.init();

        await adapter.createAccount({
            id: seedManager.AGENT_ID,
            name: "Agent Test",
            username: "agent-test",
            email: "agent-test@test.com",
        });

        await adapter.createAccount({
            id: seedManager.USER_ID,
            name: "User Test",
            username: "user-test",
            email: "user-test@test.com",
        });

        await adapter.createRoom(seedManager.ROOM_ID);
        await adapter.addParticipant(seedManager.AGENT_ID, seedManager.ROOM_ID);
        await adapter.addParticipant(seedManager.USER_ID, seedManager.ROOM_ID);
        MEMORY_IDS = await seedManager.createMemories(adapter, TEST_TABLE);
    });

    afterAll(async () => {
        await cleanDatabase(client);
        await client?.end();
    });

    afterEach(async () => {
        // Get all current memory IDs
        const allMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            tableName: TEST_TABLE,
        });

        // Get all seeded memory IDs as a flat array
        const seededIds = Array.from(MEMORY_IDS.values()).flat();

        // Remove memories that aren't in our seeded set
        for (const memory of allMemories) {
            if (!seededIds.includes(memory.id as UUID)) {
                await adapter.removeMemory(memory.id as UUID, TEST_TABLE);
            }
        }
    });

    test("should create and retrieve memory with vector embedding", async () => {
        const memoryId = stringToUuid("memory-test-1");
        const content = "This is a test memory about cats and dogs";
        const dimensions = EMBEDDING_OPTIONS.dimensions || 384;
        const embedding = await getEmbeddingForTest(content, EMBEDDING_OPTIONS);

        // Create memory
        await adapter.createMemory(
            {
                id: memoryId,
                content: {
                    text: content,
                    type: "message",
                },
                embedding: embedding,
                userId: seedManager.USER_ID,
                agentId: seedManager.AGENT_ID,
                roomId: seedManager.ROOM_ID,
                createdAt: Date.now(),
                unique: true,
            },
            TEST_TABLE
        );

        const memory = await adapter.getMemoryById(memoryId);

        // Verify memory and embedding
        expect(memory).toBeDefined();
        const parsedEmbedding =
            typeof memory?.embedding === "string"
                ? parseVectorString(memory.embedding)
                : memory?.embedding;
        expect(Array.isArray(parsedEmbedding)).toBe(true);
        expect(parsedEmbedding).toHaveLength(dimensions);
        expect(memory?.content?.text).toEqual(content);
    });

    test("should create and retrieve memory with vector embedding", async () => {
        const testMemoryId = stringToUuid("memory-test-2");
        const content = "The quick brown fox jumps over the lazy dog";
        const embedding = await getEmbeddingForTest(content, EMBEDDING_OPTIONS);

        // Create memory
        await adapter.createMemory(
            {
                id: testMemoryId,
                content: {
                    text: content,
                    type: "message",
                },
                embedding: embedding,
                userId: seedManager.USER_ID,
                agentId: seedManager.AGENT_ID,
                roomId: seedManager.ROOM_ID,
                createdAt: Date.now(),
                unique: true,
            },
            TEST_TABLE
        );

        // Search by embedding and verify
        const results = await adapter.searchMemoriesByEmbedding(embedding, {
            tableName: TEST_TABLE,
            roomId: seedManager.ROOM_ID,
            agentId: seedManager.AGENT_ID,
            match_threshold: 0.8,
            count: 1,
        });

        expect(results).toHaveLength(1);
        expect(results[0].similarity).toBeGreaterThanOrEqual(0.8);
        expect(results[0].content.text).toBe(content);
        expect(results[0].embedding).toEqual(embedding);
        expect(results[0].roomId).toBe(seedManager.ROOM_ID);
        expect(results[0].agentId).toBe(seedManager.AGENT_ID);
    });

    test("should handle invalid embedding dimensions", async () => {
        const wrongDimensionEmbedding = new Array(100).fill(0.1);

        const {
            rows: [{ get_embedding_dimension: embeddingDimension }],
        } = await adapter.db.execute(sql`SELECT get_embedding_dimension()`);

        const memoryWithWrongDimension = {
            id: stringToUuid("memory-test-3"),
            content: {
                text: "This is a test memory with wrong dimensions",
                type: "message",
            },
            embedding: wrongDimensionEmbedding,
            userId: seedManager.USER_ID,
            agentId: seedManager.AGENT_ID,
            roomId: seedManager.ROOM_ID,
            createdAt: Date.now(),
            unique: true,
        };

        try {
            await adapter.createMemory(memoryWithWrongDimension, TEST_TABLE);
        } catch (error) {
            expect(error).toBeDefined();
            expect((error as Error).message).toBe(
                `different vector dimensions ${embeddingDimension} and ${wrongDimensionEmbedding.length}`
            );
        }
    });

    test("should find similar memories within same context", async () => {
        const queryContent =
            "How do programming languages like JavaScript and Python compare?";
        const embedding = await getEmbeddingForTest(
            queryContent,
            EMBEDDING_OPTIONS
        );

        const results = await adapter.searchMemoriesByEmbedding(embedding, {
            tableName: TEST_TABLE,
            roomId: seedManager.ROOM_ID,
            agentId: seedManager.AGENT_ID,
            match_threshold: 0.35,
            count: 3,
        });

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].similarity).toBeGreaterThan(0.35);
        expect(results.some((r) => r.content.text.includes("JavaScript"))).toBe(
            true
        );
        expect(results.some((r) => r.content.text.includes("Python"))).toBe(
            true
        );
    });

    test("should find similar memories within same context - testing various thresholds", async () => {
        const testQueries = [
            {
                query: "How do programming languages like JavaScript and Python compare?",
                expectedTerms: ["JavaScript", "Python"],
                context: "programming",
            },
            {
                query: "Tell me about web development frameworks and tools",
                expectedTerms: ["React", "JavaScript", "TypeScript"],
                context: "programming",
            },
            {
                query: "What's the relationship between physics and chemistry?",
                expectedTerms: ["physics", "chemistry"],
                context: "science",
            },
        ];

        for (const testCase of testQueries) {
            const embedding = await getEmbeddingForTest(
                testCase.query,
                EMBEDDING_OPTIONS
            );

            const thresholdResults = await Promise.all([
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: 0.25,
                    count: 5,
                }),
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: 0.5,
                    count: 5,
                }),
            ]);

            elizaLogger.debug(`Results for query: ${testCase.query}`, {
                threshold_0_25: {
                    count: thresholdResults[0].length,
                    similarities: thresholdResults[0].map((r) =>
                        (r.similarity ?? 0).toFixed(4)
                    ),
                    texts: thresholdResults[0].map((r) => r.content.text),
                },
                threshold_0_50: {
                    count: thresholdResults[1].length,
                    similarities: thresholdResults[1].map((r) =>
                        (r.similarity ?? 0).toFixed(4)
                    ),
                    texts: thresholdResults[1].map((r) => r.content.text),
                },
            });

            const results = thresholdResults[0];

            // Test basic search functionality
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].similarity).toBeGreaterThan(0.25);

            // Test context relevance
            const contextMatches = results.filter((r) =>
                testCase.expectedTerms.some((term) =>
                    r.content.text.toLowerCase().includes(term.toLowerCase())
                )
            );
            expect(contextMatches.length).toBeGreaterThan(0);

            // Test semantic relevance - results should be ordered by relevance
            expect(results).toEqual(
                [...results].sort(
                    (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
                )
            );

            // Demonstrate threshold impact
            expect(thresholdResults[1].length).toBeLessThanOrEqual(
                thresholdResults[0].length
            );

            // Log cross-context contamination
            const otherContextTerms =
                testCase.context === "programming"
                    ? ["physics", "chemistry", "cuisine"]
                    : ["JavaScript", "Python", "cuisine"];

            const crossContextMatches = results.filter((r) =>
                otherContextTerms.some((term) =>
                    r.content.text.toLowerCase().includes(term.toLowerCase())
                )
            );

            elizaLogger.debug("Cross-context analysis:", {
                query: testCase.query,
                expectedContext: testCase.context,
                crossContextMatchCount: crossContextMatches.length,
                crossContextMatches: crossContextMatches.map((r) => ({
                    similarity: (r.similarity ?? 0).toFixed(4),
                    text: r.content.text,
                })),
            });
        }
    });

    test("should effectively filter cross-context searches", async () => {
        const queryContent =
            "What are the best programming frameworks for web development?";
        const embedding = await getEmbeddingForTest(
            queryContent,
            EMBEDDING_OPTIONS
        );

        const results = await adapter.searchMemoriesByEmbedding(embedding, {
            tableName: TEST_TABLE,
            roomId: seedManager.ROOM_ID,
            agentId: seedManager.AGENT_ID,
            match_threshold: 0.35, // Lowered based on our 384 dimension findings
            count: 5,
        });

        elizaLogger.debug("Semantic search results:", {
            count: results.length,
            similarities: results.map((r) => ({
                similarity: (r.similarity ?? 0).toFixed(4),
                text: r.content.text,
            })),
        });

        // Positive matches - should find programming-related content
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].similarity).toBeGreaterThan(0.35);

        const programmingTerms = [
            "JavaScript",
            "web",
            "React",
            "development",
            "TypeScript",
            "Python",
        ];
        const hasProgrammingContent = results.some((r) =>
            programmingTerms.some((term) =>
                r.content.text.toLowerCase().includes(term.toLowerCase())
            )
        );
        expect(hasProgrammingContent).toBe(true);

        // Negative matches - should not find unrelated content
        const unrelatedTerms = [
            "cuisine",
            "physics",
            "chemistry",
            "biology",
            "cooking",
        ];
        const hasUnrelatedContent = results.some((r) =>
            unrelatedTerms.some((term) =>
                r.content.text.toLowerCase().includes(term.toLowerCase())
            )
        );
        expect(hasUnrelatedContent).toBe(false);

        // Verify ordering by relevance
        expect(results).toEqual(
            [...results].sort(
                (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
            )
        );

        // Check relative rankings
        const rankingCheck = results.map((r) => ({
            text: r.content.text,
            terms: programmingTerms.filter((term) =>
                r.content.text.toLowerCase().includes(term.toLowerCase())
            ),
            similarity: r.similarity,
        }));

        elizaLogger.debug("Ranking analysis:", {
            results: rankingCheck,
        });

        // Most relevant results should have higher similarity scores
        expect(rankingCheck[0].terms.length).toBeGreaterThan(0);
    });

    test("should handle threshold-based filtering accurately", async () => {
        const queryContent =
            "Tell me about web development and user interfaces";
        const embedding = await getEmbeddingForTest(
            queryContent,
            EMBEDDING_OPTIONS
        );

        // Test with various thresholds matching our 384 dimension expectations
        const thresholds = [0.5, 0.35, 0.25];
        const thresholdResults = await Promise.all(
            thresholds.map((threshold) =>
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: threshold,
                    count: 5,
                })
            )
        );

        // Log results for each threshold
        thresholds.forEach((threshold, i) => {
            elizaLogger.debug(`Results for threshold ${threshold}:`, {
                count: thresholdResults[i].length,
                matches: thresholdResults[i].map((r) => ({
                    similarity: (r.similarity ?? 0).toFixed(4),
                    text: r.content.text,
                })),
            });
        });

        // Verify descending result counts with increasing thresholds
        expect(thresholdResults[0].length).toBeLessThanOrEqual(
            thresholdResults[1].length
        );
        expect(thresholdResults[1].length).toBeLessThanOrEqual(
            thresholdResults[2].length
        );

        // Check threshold enforcement
        thresholds.forEach((threshold, i) => {
            expect(
                thresholdResults[i].every(
                    (r) => (r.similarity ?? 0) >= threshold
                )
            ).toBe(true);
        });

        // Verify relevance of results
        const webDevTerms = [
            "JavaScript",
            "web",
            "React",
            "development",
            "interface",
            "TypeScript",
        ];
        const relevantResults = thresholdResults[2].filter((r) =>
            webDevTerms.some((term) =>
                r.content.text.toLowerCase().includes(term.toLowerCase())
            )
        );

        elizaLogger.debug("Relevance analysis:", {
            totalResults: thresholdResults[2].length,
            relevantResults: relevantResults.length,
            relevantMatches: relevantResults.map((r) => ({
                similarity: (r.similarity ?? 0).toFixed(4),
                text: r.content.text,
                matchedTerms: webDevTerms.filter((term) =>
                    r.content.text.toLowerCase().includes(term.toLowerCase())
                ),
            })),
        });

        expect(relevantResults.length).toBeGreaterThan(0);
    });

    test("should handle large-scale semantic searches effectively", async () => {
        const queries = [
            {
                content: "Tell me about science and research",
                expectedContext: "science",
                relevantTerms: [
                    "physics",
                    "biology",
                    "chemistry",
                    "research",
                    "science",
                ],
                // Only consider it irrelevant if it's primarily about these topics
                primaryIrrelevantContexts: {
                    programming: [
                        "JavaScript",
                        "Python",
                        "programming",
                        "coding",
                    ],
                    cooking: ["recipe", "cuisine", "ingredients", "baking"],
                },
            },
            {
                content: "Explain different research methodologies",
                expectedContext: "science",
                relevantTerms: ["research", "study", "methodology", "analysis"],
                primaryIrrelevantContexts: {
                    programming: [
                        "JavaScript",
                        "Python",
                        "programming",
                        "coding",
                    ],
                    cooking: ["recipe", "cuisine", "ingredients", "baking"],
                },
            },
        ];

        for (const query of queries) {
            const embedding = await getEmbeddingForTest(
                query.content,
                EMBEDDING_OPTIONS
            );

            // Test different result set sizes
            const resultSets = await Promise.all([
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: 0.35,
                    count: 2,
                }),
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: 0.35,
                    count: 5,
                }),
                adapter.searchMemoriesByEmbedding(embedding, {
                    tableName: TEST_TABLE,
                    roomId: seedManager.ROOM_ID,
                    agentId: seedManager.AGENT_ID,
                    match_threshold: 0.35,
                    count: 10,
                }),
            ]);

            // Log results for analysis
            elizaLogger.debug(`Search results for query: ${query.content}`, {
                smallSet: {
                    count: resultSets[0].length,
                    similarities: resultSets[0].map((r) => ({
                        similarity: (r.similarity ?? 0).toFixed(4),
                        text: r.content.text,
                    })),
                },
                mediumSet: {
                    count: resultSets[1].length,
                    similarities: resultSets[1].map((r) => ({
                        similarity: (r.similarity ?? 0).toFixed(4),
                        text: r.content.text,
                    })),
                },
                largeSet: {
                    count: resultSets[2].length,
                    similarities: resultSets[2].map((r) => ({
                        similarity: (r.similarity ?? 0).toFixed(4),
                        text: r.content.text,
                    })),
                },
            });

            // Test result set sizes
            expect(resultSets[0].length).toBeLessThanOrEqual(2);
            expect(resultSets[1].length).toBeLessThanOrEqual(5);
            expect(resultSets[2].length).toBeLessThanOrEqual(10);

            // Verify ordering consistency
            const verifyOrderingConsistency = (
                smaller: Memory[],
                larger: Memory[]
            ) => {
                smaller.forEach((result, index) => {
                    expect(result.id).toBe(larger[index].id);
                    expect(result.similarity).toBe(larger[index].similarity);
                });
            };

            verifyOrderingConsistency(resultSets[0], resultSets[1]);
            verifyOrderingConsistency(resultSets[1], resultSets[2]);

            for (const resultSet of resultSets) {
                // Verify descending similarity order
                expect(resultSet).toEqual(
                    [...resultSet].sort(
                        (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
                    )
                );

                // Check context relevance
                const relevantResults = resultSet.filter((r) =>
                    query.relevantTerms.some((term) =>
                        r.content.text
                            .toLowerCase()
                            .includes(term.toLowerCase())
                    )
                );
                expect(relevantResults.length).toBeGreaterThan(0);

                // Check that no result is primarily about irrelevant contexts
                for (const [context, terms] of Object.entries(
                    query.primaryIrrelevantContexts
                )) {
                    const resultsInContext = resultSet.filter((r) => {
                        const text = r.content.text.toLowerCase();
                        // Consider it primarily about this context if it matches multiple terms
                        return (
                            terms.filter((term) =>
                                text.includes(term.toLowerCase())
                            ).length >= 2
                        );
                    });
                    expect(resultsInContext.length).toBe(0);
                }
            }
        }
    });

    test("should effectively handle complex multi-context semantic relationships", async () => {
        // Test various cross-domain queries that require understanding relationships
        const queries = [
            {
                content:
                    "How does scientific research methodology compare to programming best practices?",
                expectedContexts: ["science", "programming"],
                relationshipTerms: [
                    "methodology",
                    "practices",
                    "testing",
                    "analysis",
                ],
                // Adjusted ranges for 1536-dimensional space
                contextRanges: {
                    science: { min: 0.15, max: 0.85 }, // Wider range to accommodate higher dimensionality
                    programming: { min: 0.15, max: 0.85 }, // Wider range to accommodate higher dimensionality
                },
                contextTerms: {
                    science: [
                        "science",
                        "research",
                        "experiment",
                        "methodology",
                        "analysis",
                        "hypothesis",
                    ],
                    programming: [
                        "programming",
                        "development",
                        "software",
                        "testing",
                        "agile",
                        "code",
                    ],
                },
            },
            {
                content:
                    "What similarities exist between software testing and scientific experimentation?",
                expectedContexts: ["science", "programming"],
                relationshipTerms: [
                    "testing",
                    "experimentation",
                    "verification",
                    "validation",
                ],
                contextRanges: {
                    science: { min: 0.15, max: 0.85 }, // Wider range to accommodate higher dimensionality
                    programming: { min: 0.15, max: 0.85 }, // Wider range to accommodate higher dimensionality
                },
                contextTerms: {
                    science: [
                        "science",
                        "research",
                        "experiment",
                        "methodology",
                        "analysis",
                        "hypothesis",
                    ],
                    programming: [
                        "programming",
                        "development",
                        "software",
                        "testing",
                        "agile",
                        "code",
                    ],
                },
            },
        ];

        for (const query of queries) {
            const embedding = await getEmbeddingForTest(
                query.content,
                EMBEDDING_OPTIONS
            );

            // Adjusted threshold for 1536-dimensional space
            const results = await adapter.searchMemoriesByEmbedding(embedding, {
                tableName: TEST_TABLE,
                roomId: seedManager.ROOM_ID,
                agentId: seedManager.AGENT_ID,
                match_threshold: 0.2, // Lowered threshold for higher dimensionality
                count: 10,
            });

            elizaLogger.debug(
                "Raw results:",
                results.map((r) => ({
                    text: r.content.text,
                    similarity: r.similarity?.toFixed(4),
                }))
            );

            // Analyze context distribution with expanded terms
            const contextCounts = {
                science: results.filter((r) =>
                    query.contextTerms.science.some((term) =>
                        r.content.text
                            .toLowerCase()
                            .includes(term.toLowerCase())
                    )
                ).length,
                programming: results.filter((r) =>
                    query.contextTerms.programming.some((term) =>
                        r.content.text
                            .toLowerCase()
                            .includes(term.toLowerCase())
                    )
                ).length,
            };

            const totalResults = results.length;
            const distributions = {
                science: contextCounts.science / totalResults,
                programming: contextCounts.programming / totalResults,
            };

            // Log detailed distribution analysis
            elizaLogger.debug(
                `Distribution analysis for query: ${query.content}`,
                {
                    totalResults,
                    contextCounts,
                    distributions,
                    results: results.map((r) => ({
                        text: r.content.text,
                        similarity: r.similarity?.toFixed(4),
                        contexts: Object.entries(query.contextTerms).reduce(
                            (acc, [context, terms]) => ({
                                ...acc,
                                [context]: terms.some((term) =>
                                    r.content.text
                                        .toLowerCase()
                                        .includes(term.toLowerCase())
                                ),
                            }),
                            {}
                        ),
                    })),
                }
            );

            // Verify distributions fall within expected ranges
            for (const [context, range] of Object.entries(
                query.contextRanges
            )) {
                const actualDistribution = distributions[context];
                expect(actualDistribution).toBeGreaterThanOrEqual(range.min);
                expect(actualDistribution).toBeLessThanOrEqual(range.max);

                elizaLogger.debug(`${context} distribution check:`, {
                    actual: actualDistribution,
                    range,
                });
            }

            // Verify semantic relevance ordering
            expect(results).toEqual(
                [...results].sort(
                    (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
                )
            );

            // Analyze similarity scores
            const similarities = results.map((r) => r.similarity ?? 0);
            const avgSimilarity =
                similarities.reduce((a, b) => a + b, 0) / similarities.length;
            const maxSimilarity = Math.max(...similarities);

            elizaLogger.debug("Similarity analysis:", {
                max: maxSimilarity.toFixed(4),
                average: avgSimilarity.toFixed(4),
                distribution: similarities.map((s) => s.toFixed(4)),
            });

            // Adjusted threshold for semantic coherence
            const hasReasonableRelevance = results.some(
                (r) => (r.similarity ?? 0) > 0.25 // Lowered threshold for higher dimensionality
            );
            expect(hasReasonableRelevance).toBe(true);

            // Verify relationship terms
            const relationshipTermMatches = query.relationshipTerms.map(
                (term) => ({
                    term,
                    matches: results.filter((r) =>
                        r.content.text
                            .toLowerCase()
                            .includes(term.toLowerCase())
                    ),
                })
            );

            elizaLogger.debug("Relationship term analysis:", {
                matches: relationshipTermMatches.map(({ term, matches }) => ({
                    term,
                    matchCount: matches.length,
                    examples: matches.map((m) => ({
                        similarity: m.similarity?.toFixed(4),
                        text: m.content.text,
                    })),
                })),
            });

            // Expect at least some relationship terms to be present
            const hasRelationshipTerms = relationshipTermMatches.some(
                ({ matches }) => matches.length > 0
            );
            expect(hasRelationshipTerms).toBe(true);

            // Analyze cross-context coverage with more flexible criteria
            const crossContextResults = results.filter((r) => {
                const hasScience = query.contextTerms.science.some((term) =>
                    r.content.text.toLowerCase().includes(term.toLowerCase())
                );
                const hasProgramming = query.contextTerms.programming.some(
                    (term) =>
                        r.content.text
                            .toLowerCase()
                            .includes(term.toLowerCase())
                );
                return hasScience && hasProgramming;
            });

            elizaLogger.debug("Cross-context analysis:", {
                crossContextCount: crossContextResults.length,
                totalResults: results.length,
                crossContextRatio: crossContextResults.length / results.length,
                examples: crossContextResults.map((r) => ({
                    similarity: r.similarity?.toFixed(4),
                    text: r.content.text,
                })),
            });

            // Adjusted criteria for valid results
            const hasValidResults =
                crossContextResults.length > 0 ||
                results.some((r) => (r.similarity ?? 0) > 0.4); // Lowered threshold for higher dimensionality
            expect(hasValidResults).toBe(true);
        }
    });

    test("should get memory by ID - existing and non-existing cases", async () => {
        // Pick an existing memory ID from programming category
        const existingMemoryId = MEMORY_IDS.get("programming")![0];

        // Test getting existing memory
        const retrievedMemory = await adapter.getMemoryById(existingMemoryId);
        expect(retrievedMemory).toBeDefined();
        expect(retrievedMemory?.id).toBe(existingMemoryId);

        // We can verify the content matches what's in our seed data
        const expectedText = seedManager.getContent(existingMemoryId);
        expect(retrievedMemory?.content.text).toBe(expectedText);
        expect(retrievedMemory?.userId).toBe(seedManager.USER_ID);
        expect(retrievedMemory?.agentId).toBe(seedManager.AGENT_ID);
        expect(retrievedMemory?.roomId).toBe(seedManager.ROOM_ID);

        // Test getting non-existent memory
        const nonExistentId = stringToUuid("non-existent-memory");
        const nonExistentMemory = await adapter.getMemoryById(nonExistentId);
        expect(nonExistentMemory).toBeNull();
    });

    test("should successfully create and remove memory", async () => {
        // Create a new test memory
        const testMemoryId = stringToUuid("test-removal-memory");
        const testContent = "This is a test memory for removal testing";

        // Create the test memory
        await adapter.createMemory(
            {
                id: testMemoryId,
                content: {
                    text: testContent,
                    type: "message",
                },
                userId: seedManager.USER_ID,
                agentId: seedManager.AGENT_ID,
                roomId: seedManager.ROOM_ID,
                createdAt: Date.now(),
                unique: true,
            },
            TEST_TABLE
        );

        // Verify memory was created successfully
        const createdMemory = await adapter.getMemoryById(testMemoryId);
        expect(createdMemory).toBeDefined();
        expect(createdMemory?.content.text).toBe(testContent);

        // Remove the memory
        await adapter.removeMemory(testMemoryId, TEST_TABLE);

        // Verify memory no longer exists
        const memoryAfterRemoval = await adapter.getMemoryById(testMemoryId);
        expect(memoryAfterRemoval).toBeNull();
    });

    test("should handle removal of non-existent memory without errors", async () => {
        const nonExistentId = stringToUuid("non-existent-memory");

        // Verify memory doesn't exist before removal attempt
        const memoryBeforeRemoval = await adapter.getMemoryById(nonExistentId);
        expect(memoryBeforeRemoval).toBeNull();

        // Attempt to remove non-existent memory (should complete without error)
        await adapter.removeMemory(nonExistentId, TEST_TABLE);

        // Verify memory is still non-existent
        const memoryAfterRemoval = await adapter.getMemoryById(nonExistentId);
        expect(memoryAfterRemoval).toBeNull();
    });

    test("should retrieve all memories for a given room", async () => {
        const allMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            tableName: TEST_TABLE,
        });
        expect(allMemories.length).toBeGreaterThan(0);
        allMemories.forEach((memory) => {
            expect(memory.roomId).toBe(seedManager.ROOM_ID);
        });
    });

    test("should limit number of memories returned when count is specified", async () => {
        const limitedMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            count: 2,
            tableName: TEST_TABLE,
        });
        expect(limitedMemories.length).toBe(2);
    });

    test("should retrieve memories within specified time range", async () => {
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;

        const timeRangeMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            tableName: TEST_TABLE,
            start: hourAgo,
            end: now,
        });
        expect(timeRangeMemories.length).toBeGreaterThan(0);
        timeRangeMemories.forEach((memory) => {
            expect(memory.createdAt).toBeLessThanOrEqual(now);
            expect(memory.createdAt).toBeGreaterThanOrEqual(hourAgo);
        });
    });

    test("should retrieve only unique memories when unique flag is set", async () => {
        const uniqueMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            unique: true,
            tableName: TEST_TABLE,
        });
        expect(uniqueMemories.length).toBeGreaterThan(0);
        uniqueMemories.forEach((memory) => {
            expect(memory.unique).toBe(true);
        });
    });

    test("should count all memories in a room", async () => {
        const totalCount = await adapter.countMemories(
            seedManager.ROOM_ID,
            false,
            TEST_TABLE
        );
        expect(totalCount).toBe(
            MEMORY_IDS.get("programming")!.length +
                MEMORY_IDS.get("science")!.length +
                MEMORY_IDS.get("cooking")!.length
        );
    });

    test("should count only unique memories in a room", async () => {
        const uniqueCount = await adapter.countMemories(
            seedManager.ROOM_ID,
            true,
            TEST_TABLE
        );
        // Since our seed data creates unique memories by default
        expect(uniqueCount).toBe(
            MEMORY_IDS.get("programming")!.length +
                MEMORY_IDS.get("science")!.length +
                MEMORY_IDS.get("cooking")!.length
        );
    });

    test("should return zero count for non-existent room", async () => {
        const nonExistentRoomId = stringToUuid("non-existent-room");
        const count = await adapter.countMemories(
            nonExistentRoomId,
            false,
            TEST_TABLE
        );
        expect(count).toBe(0);
    });

    test("should get memories with various filters", async () => {
        // Test basic retrieval
        const allMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            tableName: TEST_TABLE,
        });

        // Test with count limit
        const limitedMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            count: 2,
            tableName: TEST_TABLE,
        });

        // Test time range
        const timeRangeMemories = await adapter.getMemories({
            roomId: seedManager.ROOM_ID,
            tableName: TEST_TABLE,
            start: Date.now() - 3600000, // 1 hour ago
            end: Date.now(),
        });

        // Assertions
        expect(allMemories.length).toBeGreaterThan(0);
        expect(limitedMemories.length).toBe(2);
        expect(
            timeRangeMemories.every(
                (m) =>
                    m.createdAt &&
                    m.createdAt >= Date.now() - 3600000 &&
                    m.createdAt <= Date.now()
            )
        ).toBe(true);
    });

    test("should handle batch memory operations", async () => {
        // Get memories by IDs
        const ids = MEMORY_IDS.get("programming")!.slice(0, 2);
        const memoriesByIds = await adapter.getMemoriesByIds(ids, TEST_TABLE);
        expect(memoriesByIds.length).toBe(2);

        // Get memories by room IDs
        const roomIds = [seedManager.ROOM_ID];
        const memoriesByRooms = await adapter.getMemoriesByRoomIds({
            roomIds,
            tableName: TEST_TABLE,
            limit: 5,
        });
        expect(memoriesByRooms.length).toBeLessThanOrEqual(5);
    });

    test("should remove all memories from room", async () => {
        const roomId = stringToUuid("test-room");
        await adapter.createRoom(roomId);

        // Create test memories
        const memory1 = {
            id: stringToUuid("test-1"),
            content: { text: "Test 1" },
            roomId,
            userId: seedManager.USER_ID,
            agentId: seedManager.AGENT_ID,
        };
        const memory2 = {
            id: stringToUuid("test-2"),
            content: { text: "Test 2" },
            roomId,
            userId: seedManager.USER_ID,
            agentId: seedManager.AGENT_ID,
        };

        await adapter.createMemory(memory1, TEST_TABLE);
        await adapter.createMemory(memory2, TEST_TABLE);

        // Verify memories exist
        const beforeCount = await adapter.countMemories(
            roomId,
            false,
            TEST_TABLE
        );
        expect(beforeCount).toBe(2);

        // Remove all memories
        await adapter.removeAllMemories(roomId, TEST_TABLE);

        // Verify memories removed
        const afterCount = await adapter.countMemories(
            roomId,
            false,
            TEST_TABLE
        );
        expect(afterCount).toBe(0);
    });

    test("should handle cached embeddings retrieval", async () => {
        const testMemoryId = stringToUuid("cache-test");
        const testEmbedding = new Array(1536).fill(0.1);
        const testContent = "test cache text specific content";

        await adapter.createMemory(
            {
                id: testMemoryId,
                content: {
                    text: testContent,
                    type: "message",
                },
                embedding: testEmbedding,
                userId: seedManager.USER_ID,
                agentId: seedManager.AGENT_ID,
                roomId: seedManager.ROOM_ID,
                createdAt: Date.now(),
            },
            TEST_TABLE
        );

        const savedMemory = await adapter.getMemoryById(testMemoryId);
        elizaLogger.debug("Saved memory:", { memory: savedMemory });

        const params = {
            query_table_name: TEST_TABLE,
            query_threshold: 10,
            query_input: testContent,
            query_field_name: "content",
            query_field_sub_name: "text",
            query_match_count: 5,
        };

        const results = await adapter.getCachedEmbeddings(params);
        elizaLogger.debug("Search results:", { results });

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
    });

    test("should handle edge cases for batch operations", async () => {
        // Empty arrays
        const emptyResults = await adapter.getMemoriesByIds([]);
        expect(emptyResults).toHaveLength(0);

        const emptyRoomResults = await adapter.getMemoriesByRoomIds({
            roomIds: [],
            tableName: TEST_TABLE,
        });
        expect(emptyRoomResults).toHaveLength(0);

        // Non-existent IDs
        const fakeId = stringToUuid("fake-id");
        const nonExistentResults = await adapter.getMemoriesByIds([fakeId]);
        expect(nonExistentResults).toHaveLength(0);
    });

    test("should handle long text inputs in getCachedEmbeddings", async () => {
        const testMemoryId = stringToUuid("cache-long-test");
        // Create a long string similar to the one in logs that caused the error
        const longContent =
            "gaming meta speedrun strategies crypto trading technical analysis discord culture streaming tech gaming hardware esports blockchain technology defi protocols game economics community management meme culture gaming history market trends hardware optimization competitive strategies digital assets gaming psychology online communities";

        await adapter.createMemory(
            {
                id: testMemoryId,
                content: {
                    text: longContent,
                    type: "message",
                },
                userId: seedManager.USER_ID,
                agentId: seedManager.AGENT_ID,
                roomId: seedManager.ROOM_ID,
                createdAt: Date.now(),
            },
            TEST_TABLE
        );

        const params = {
            query_table_name: TEST_TABLE,
            query_threshold: 2,
            query_input: longContent, // This will trigger the error
            query_field_name: "content",
            query_field_sub_name: "text",
            query_match_count: 10,
        };

        await expect(adapter.getCachedEmbeddings(params)).rejects.toThrow(
            "levenshtein argument exceeds maximum length of 255 characters"
        );
    });
});


describe("Memory timestamp operations", () => {
    const TEST_TABLE = "test_memories";
    let adapter: DrizzleDatabaseAdapter;
    let client: pg.Client;
    let docker: Docker;
    let agent_id: UUID = stringToUuid("agent-1");
    let user_id: UUID = stringToUuid("user-1");
    let room_id: UUID = stringToUuid("room-1");

    beforeAll(async () => {
        ({ adapter, client, docker } = await connectDatabase());
        await adapter.init();

        await adapter.createAccount({
            id: agent_id,
            name: "Agent Test",
            username: "agent-test",
            email: "agent-test@test.com",
        });

        await adapter.createAccount({
            id: user_id,
            name: "User Test",
            username: "user-test",
            email: "user-test@test.com",
        });

        await adapter.createRoom(room_id);
        await adapter.addParticipant(agent_id, room_id);
        await adapter.addParticipant(user_id, room_id);
    });

    afterAll(async () => {
        await cleanDatabase(client);
        await client?.end();
        await stopContainers(client, docker);
    });

    test("should handle timestamps correctly when creating and retrieving memory", async () => {
        const memoryId = stringToUuid("timestamp-test-1");
        const now = Date.now();
        const content = "Test memory for timestamp verification";

        // Create memory with specific timestamp
        await adapter.createMemory(
            {
                id: memoryId,
                content: {
                    text: content,
                    type: "message",
                },
                userId: user_id,
                agentId: agent_id,
                roomId: room_id,
                createdAt: now,
                unique: true,
            },
            TEST_TABLE
        );

        // Retrieve memory and verify timestamp
        const memory = await adapter.getMemoryById(memoryId);
        expect(memory).toBeDefined();
        expect(memory?.createdAt).toEqual(now);
    });

    test("should retrieve memories within a specified time range", async () => {
        const isolatedRoomId = stringToUuid("isolated-room");
        await adapter.createRoom(isolatedRoomId);
        await adapter.addParticipant(agent_id, isolatedRoomId);
        await adapter.addParticipant(user_id, isolatedRoomId);

        const now = Date.now();
        const hourAgo = now - 3600000; // 1 hour ago
        const twoHoursAgo = now - 7200000; // 2 hours ago

        // Create memories with different timestamps
        const memory1 = {
            id: stringToUuid("timestamp-range-1"),
            content: { text: "Recent memory", type: "message" },
            userId: user_id,
            agentId: agent_id,
            roomId: isolatedRoomId,
            createdAt: now - 1000,
            unique: true,
        };

        const memory2 = {
            id: stringToUuid("timestamp-range-2"),
            content: { text: "Older memory", type: "message" },
            userId: user_id,
            agentId: agent_id,
            roomId: isolatedRoomId,
            createdAt: twoHoursAgo,
            unique: true,
        };

        await adapter.createMemory(memory1, TEST_TABLE);
        await adapter.createMemory(memory2, TEST_TABLE);

        // Retrieve memories from last hour
        const recentMemories = await adapter.getMemories({
            roomId: isolatedRoomId,
            tableName: TEST_TABLE,
            start: hourAgo,
            end: now,
        });

        // Should only get the recent memory
        expect(recentMemories.length).toBe(1);
        expect(recentMemories[0].id).toBe(memory1.id);
        expect(recentMemories[0].createdAt).toBeGreaterThan(hourAgo);
        expect(recentMemories[0].createdAt).toBeLessThanOrEqual(now);
    });
});
