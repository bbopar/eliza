import { EmbeddingOptions, RAGKnowledgeItem, stringToUuid, type UUID } from "@elizaos/core";
import { getEmbeddingForTest } from "@elizaos/core";
import { PostgresDatabaseAdapter } from "..";

// Configuration
export const EMBEDDING_OPTIONS: EmbeddingOptions = {
    model: "text-embedding-3-small",
    endpoint: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    dimensions: 1536,
    isOllama: false,
    provider: "OpenAI",
};

// Test agents
export const AGENT_1_ID = stringToUuid("test-agent-1");
export const AGENT_2_ID = stringToUuid("test-agent-2");
export const AGENT_3_ID = stringToUuid("test-agent-3");
export const AGENT_4_ID = stringToUuid("test-agent-4");
export const AGENT_5_ID = stringToUuid("test-agent-5");

// Categories for organization
const CATEGORIES = {
    TECH: "technology",
    SCIENCE: "science",
    BUSINESS: "business",
    INTERNAL: "internal"
};

interface TestKnowledgeData {
    mainItems: {
        shared: RAGKnowledgeItem[];
        private: RAGKnowledgeItem[];
    };
    documentWithChunks: {
        main: RAGKnowledgeItem;
        chunks: RAGKnowledgeItem[];
    }[];
    crossAgentItems: RAGKnowledgeItem[];
}

async function createKnowledgeItem(
    params: {
        text: string,
        isShared: boolean,
        agentId: UUID,
        category: string,
        isMain?: boolean,
        originalId?: UUID,
        chunkIndex?: number
    }
): Promise<RAGKnowledgeItem> {
    const embedding = await getEmbeddingForTest(params.text, EMBEDDING_OPTIONS);
    const timestamp = Date.now();
    
    // Generate deterministic but unique ID
    const idBase = params.originalId ? 
        `chunk-${params.originalId}-${params.chunkIndex}` :
        `item-${params.text.slice(0, 10)}-${params.category}`;
    const uniqueId = stringToUuid(`${idBase}-${timestamp}`);

    return {
        id: uniqueId,
        agentId: params.agentId,
        content: {
            text: params.text,
            metadata: {
                isMain: !params.originalId,
                isChunk: !!params.originalId,
                category: params.category,
                isShared: params.isShared,
                originalId: params.originalId,
                chunkIndex: params.chunkIndex
            }
        },
        embedding: new Float32Array(embedding),
        createdAt: timestamp
    };
}

export async function setupKnowledgeTestData(adapter: PostgresDatabaseAdapter): Promise<TestKnowledgeData> {
    // 1. Shared main documents (public knowledge)
    const sharedMainItems = await Promise.all([
        // Technical content
        createKnowledgeItem({
            text: "Machine Learning fundamentals include supervised and unsupervised learning approaches",
            isShared: true,
            agentId: AGENT_1_ID,
            category: CATEGORIES.TECH
        }),
        createKnowledgeItem({
            text: "Cloud computing enables scalable infrastructure and services",
            isShared: true,
            agentId: AGENT_1_ID,
            category: CATEGORIES.TECH
        }),
        // Science content
        createKnowledgeItem({
            text: "Quantum mechanics describes behavior at atomic and subatomic levels",
            isShared: true,
            agentId: AGENT_1_ID,
            category: CATEGORIES.SCIENCE
        }),
        // Business content
        createKnowledgeItem({
            text: "Agile methodology promotes iterative development and continuous feedback",
            isShared: true,
            agentId: AGENT_1_ID,
            category: CATEGORIES.BUSINESS
        })
    ]);

    // 2. Private main documents
    const privateMainItems = await Promise.all([
        // Private technical docs
        createKnowledgeItem({
            text: "Internal API documentation and authentication flows",
            isShared: false,
            agentId: AGENT_1_ID,
            category: CATEGORIES.INTERNAL
        }),
        createKnowledgeItem({
            text: "System architecture and deployment strategies",
            isShared: false,
            agentId: AGENT_1_ID,
            category: CATEGORIES.INTERNAL
        }),
        // Private business docs
        createKnowledgeItem({
            text: "Q4 2024 Strategic planning and objectives",
            isShared: false,
            agentId: AGENT_2_ID,
            category: CATEGORIES.INTERNAL
        })
    ]);

    // 3. Documents with chunks (one shared, one private)
    const documentsWithChunks = await Promise.all([
        // Shared document with chunks
        (async () => {
            const mainDoc = await createKnowledgeItem({
                text: "Complete Guide to Modern Software Development",
                isShared: true,
                agentId: AGENT_1_ID,
                category: CATEGORIES.TECH
            });

            const chunks = await Promise.all([
                createKnowledgeItem({
                    text: "Chapter 1: Version Control and Git Fundamentals",
                    isShared: true,
                    agentId: AGENT_1_ID,
                    category: CATEGORIES.TECH,
                    originalId: mainDoc.id,
                    chunkIndex: 0
                }),
                createKnowledgeItem({
                    text: "Chapter 2: Continuous Integration Best Practices",
                    isShared: true,
                    agentId: AGENT_1_ID,
                    category: CATEGORIES.TECH,
                    originalId: mainDoc.id,
                    chunkIndex: 1
                }),
                createKnowledgeItem({
                    text: "Chapter 3: Automated Testing Strategies",
                    isShared: true,
                    agentId: AGENT_1_ID,
                    category: CATEGORIES.TECH,
                    originalId: mainDoc.id,
                    chunkIndex: 2
                })
            ]);

            return { main: mainDoc, chunks };
        })(),
        // Private document with chunks
        (async () => {
            const mainDoc = await createKnowledgeItem({
                text: "Internal Company Handbook 2024",
                isShared: false,
                agentId: AGENT_2_ID,
                category: CATEGORIES.INTERNAL
            });

            const chunks = await Promise.all([
                createKnowledgeItem({
                    text: "Section 1: Company Policies and Procedures",
                    isShared: false,
                    agentId: AGENT_2_ID,
                    category: CATEGORIES.INTERNAL,
                    originalId: mainDoc.id,
                    chunkIndex: 0
                }),
                createKnowledgeItem({
                    text: "Section 2: Employee Benefits and Resources",
                    isShared: false,
                    agentId: AGENT_2_ID,
                    category: CATEGORIES.INTERNAL,
                    originalId: mainDoc.id,
                    chunkIndex: 1
                })
            ]);

            return { main: mainDoc, chunks };
        })()
    ]);

    // 4. Cross-agent shared knowledge
    const crossAgentItems = await Promise.all([
        createKnowledgeItem({
            text: "Cross-team collaboration guidelines and best practices",
            isShared: true,
            agentId: AGENT_1_ID,
            category: CATEGORIES.BUSINESS
        }),
        createKnowledgeItem({
            text: "Project management methodology overview",
            isShared: true,
            agentId: AGENT_2_ID,
            category: CATEGORIES.BUSINESS
        }),
        createKnowledgeItem({
            text: "Inter-departmental communication protocols",
            isShared: true,
            agentId: AGENT_3_ID,
            category: CATEGORIES.BUSINESS
        })
    ]);

    // Save all items to database
    const allItems = [
        ...sharedMainItems,
        ...privateMainItems,
        ...documentsWithChunks.flatMap(doc => [doc.main, ...doc.chunks]),
        ...crossAgentItems
    ];

    for (const item of allItems) {
        await adapter.createKnowledge(item);
    }

    return {
        mainItems: {
            shared: sharedMainItems,
            private: privateMainItems
        },
        documentWithChunks: documentsWithChunks,
        crossAgentItems
    };
}