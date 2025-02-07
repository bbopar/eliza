import {
    type Account,
    type Actor,
    DatabaseAdapter,
    EmbeddingProvider,
    type GoalStatus,
    type Participant,
    type RAGKnowledgeItem,
    elizaLogger,
    getEmbeddingConfig,
    type Goal,
    type IDatabaseCacheAdapter,
    type Memory,
    type Relationship,
    type UUID,
} from "@elizaos/core";
import {
    and,
    eq,
    gte,
    lte,
    sql,
    desc,
    inArray,
    or,
    cosineDistance,
} from "drizzle-orm";
import {
    accountTable,
    goalTable,
    logTable,
    memoryTable,
    participantTable,
    relationshipTable,
    roomTable,
    knowledgeTable,
    cacheTable,
} from "./schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { v4 as uuid } from "uuid";
import { runMigrations } from "./migrations";
import pkg from "pg";
const { Pool } = pkg;

export class DrizzleDatabaseAdapter
    extends DatabaseAdapter<NodePgDatabase>
    implements IDatabaseCacheAdapter
{
    private databaseUrl: string;
    private databaseName: string;

    constructor(
        databaseUrl: string,
        // TODO: drizzle has it's own circuit breaker config...
        circuitBreakerConfig?: {
            failureThreshold?: number;
            resetTimeout?: number;
            halfOpenMaxAttempts?: number;
        }
    ) {
        super({
            failureThreshold: circuitBreakerConfig?.failureThreshold ?? 5,
            resetTimeout: circuitBreakerConfig?.resetTimeout ?? 60000,
            halfOpenMaxAttempts: circuitBreakerConfig?.halfOpenMaxAttempts ?? 3,
        });
        this.databaseUrl = databaseUrl;
        this.databaseName = this.setDatabaseName();
        this.db = drizzle(databaseUrl);
    }

    async init(): Promise<void> {
        try {
            await this.setEmbeddingProviderSettings();

            const { rows } = await this.db.execute(sql`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'rooms'
                );
            `);

            if (!rows[0].exists || !(await this.validateVectorSetup())) {
                const pool = new Pool({
                    connectionString: this.databaseUrl,
                });
                await runMigrations(pool);
                await pool.end();
            }
        } catch (error) {
            elizaLogger.error("Failed to initialize database:", error);
            throw error;
        }
    }

    private setDatabaseName(): string {
        const DATABASE_NAME_PATTERN = /\/([^\/\?]+)(?:\?|$)/;
        const matches = this.databaseUrl.match(DATABASE_NAME_PATTERN);
        return matches?.[1] || "postgres";
    }

    private async setEmbeddingProviderSettings(): Promise<void> {
        const embeddingConfig = getEmbeddingConfig();
        const providers = ["openai", "ollama", "gaianet"] as const;

        try {
            await this.db.transaction(async (tx) => {
                for (const provider of providers) {
                    const query = sql.raw(
                        `ALTER DATABASE "${this.databaseName}" SET app.use_${provider}_embedding = 'false'`
                    );
                    await tx.execute(query);
                }

                if (
                    Object.values(EmbeddingProvider).includes(
                        embeddingConfig.provider
                    )
                ) {
                    const providerName = embeddingConfig.provider.toLowerCase();
                    const query = sql.raw(
                        `ALTER DATABASE "${this.databaseName}" SET app.use_${providerName}_embedding = 'true'`
                    );
                    await tx.execute(query);
                }
            });
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.includes("tuple concurrently updated")
            ) {
                elizaLogger.info(
                    "Database settings already updated by another connection"
                );
                return;
            }
            throw error;
        }
    }

    private async validateVectorSetup(): Promise<boolean> {
        try {
            const vectorExt = await this.db.execute(sql`
                SELECT * FROM pg_extension WHERE extname = 'vector'
            `);

            const hasVector = vectorExt?.rows.length > 0;

            if (!hasVector) {
                elizaLogger.warn("Vector extension not found");
                return false;
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error validating vector setup:", error);
            return false;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.db && (this.db as any).client) {
                await (this.db as any).client.close();
            }
        } catch (error) {
            elizaLogger.error("Failed to close database connection:", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        try {
            const result = await this.db
                .select()
                .from(accountTable)
                .where(eq(accountTable.id, userId))
                .limit(1);

            if (result.length === 0) return null;

            const account = result[0];

            return {
                id: account.id as UUID,
                name: account.name ?? "",
                username: account.username ?? "",
                email: account.email ?? "",
                avatarUrl: account.avatarUrl ?? "",
                details: account.details ?? {},
            };
        } catch (error) {
            elizaLogger.error("Failed to get account by ID:", {
                error: error instanceof Error ? error.message : String(error),
                userId,
            });
            throw error;
        }
    }

    async createAccount(account: Account): Promise<boolean> {
        try {
            const accountId = account.id ?? uuid();

            await this.db.insert(accountTable).values({
                id: accountId,
                name: account.name ?? null,
                username: account.username ?? null,
                email: account.email ?? "",
                avatarUrl: account.avatarUrl ?? null,
                details: sql`${account.details}::jsonb` || {},
            });

            elizaLogger.debug("Account created successfully:", {
                accountId,
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error creating account:", {
                error: error instanceof Error ? error.message : String(error),
                accountId: account.id,
            });
            return false;
        }
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId?: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) throw new Error("tableName is required");
        if (!params.roomId) throw new Error("roomId is required");

        try {
            const conditions = [
                eq(memoryTable.type, params.tableName),
                eq(memoryTable.roomId, params.roomId),
            ];

            if (params.start) {
                conditions.push(gte(memoryTable.createdAt, params.start));
            }

            if (params.end) {
                conditions.push(lte(memoryTable.createdAt, params.end));
            }

            if (params.unique) {
                conditions.push(eq(memoryTable.unique, true));
            }

            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }

            const query = this.db
                .select()
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            const rows = params.count
                ? await query.limit(params.count)
                : await query;

            return rows.map((row) => ({
                id: row.id as UUID,
                type: row.type,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            }));
        } catch (error) {
            elizaLogger.error("Failed to fetch memories:", {
                error: error instanceof Error ? error.message : String(error),
                params,
            });
            throw error;
        }
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        agentId?: UUID;
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        try {
            if (params.roomIds.length === 0) return [];

            const conditions = [
                eq(memoryTable.type, params.tableName),
                inArray(memoryTable.roomId, params.roomIds),
            ];

            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }

            const query = this.db
                .select()
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            const rows = params.limit
                ? await query.limit(params.limit)
                : await query;

            return rows.map((row) => ({
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            })) as Memory[];
        } catch (error) {
            elizaLogger.error("Error in getMemoriesByRoomIds:", {
                error: error instanceof Error ? error.message : String(error),
                roomIds: params.roomIds,
                tableName: params.tableName,
            });
            throw error;
        }
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        try {
            const result = await this.db
                .select()
                .from(memoryTable)
                .where(eq(memoryTable.id, id))
                .limit(1);

            if (result.length === 0) return null;

            const row = result[0];
            return {
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            };
        } catch (error) {
            elizaLogger.error("Error in getMemoryById:", error);
            throw error;
        }
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        if (memoryIds.length === 0) return [];

        try {
            const conditions = [inArray(memoryTable.id, memoryIds)];

            if (tableName) {
                conditions.push(eq(memoryTable.type, tableName));
            }

            const rows = await this.db
                .select()
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            return rows.map((row) => ({
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            }));
        } catch (error) {
            elizaLogger.error("Failed to fetch memories by IDs:", {
                error: error instanceof Error ? error.message : String(error),
                memoryIds,
                tableName,
            });
            throw error;
        }
    }

    async getCachedEmbeddings(params: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
        try {
            const results = await this.db.execute<{
                embedding: number[];
                levenshtein_score: number;
            }>(sql`
                WITH content_text AS (
                    SELECT 
                        embedding,
                        COALESCE(
                            content->>${params.query_field_sub_name},
                            ''
                        ) as content_text
                    FROM memories 
                    WHERE type = ${params.query_table_name}
                    AND content->>${params.query_field_sub_name} IS NOT NULL
                )
                SELECT 
                    embedding,
                    levenshtein(${params.query_input}, content_text) as levenshtein_score
                FROM content_text
                WHERE levenshtein(${params.query_input}, content_text) <= ${params.query_threshold}
                ORDER BY levenshtein_score
                LIMIT ${params.query_match_count}
            `);

            return results.rows
                .map((row) => ({
                    embedding: Array.isArray(row.embedding)
                        ? row.embedding
                        : typeof row.embedding === "string"
                        ? JSON.parse(row.embedding)
                        : [],
                    levenshtein_score: Number(row.levenshtein_score),
                }))
                .filter((row) => Array.isArray(row.embedding));
        } catch (error) {
            elizaLogger.error("Error in getCachedEmbeddings:", {
                error: error instanceof Error ? error.message : String(error),
                tableName: params.query_table_name,
                fieldName: params.query_field_name,
            });
            if (
                error instanceof Error &&
                error.message ===
                    "levenshtein argument exceeds maximum length of 255 characters"
            ) {
                return [];
            }
            throw error;
        }
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        try {
            await this.db.insert(logTable).values({
                body: sql`${params.body}::jsonb`,
                userId: params.userId,
                roomId: params.roomId,
                type: params.type,
            });
        } catch (error) {
            elizaLogger.error("Failed to create log entry:", {
                error: error instanceof Error ? error.message : String(error),
                type: params.type,
                roomId: params.roomId,
                userId: params.userId,
            });
            throw error;
        }
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        if (!params.roomId) {
            throw new Error("roomId is required");
        }

        try {
            const result = await this.db
                .select({
                    id: accountTable.id,
                    name: accountTable.name,
                    username: accountTable.username,
                    details: accountTable.details,
                })
                .from(participantTable)
                .leftJoin(
                    accountTable,
                    eq(participantTable.userId, accountTable.id)
                )
                .where(eq(participantTable.roomId, params.roomId))
                .orderBy(accountTable.name);

            elizaLogger.debug("Retrieved actor details:", {
                roomId: params.roomId,
                actorCount: result.length,
            });

            return result.map((row) => {
                try {
                    const details =
                        typeof row.details === "string"
                            ? JSON.parse(row.details)
                            : row.details || {};

                    return {
                        id: row.id as UUID,
                        name: row.name ?? "",
                        username: row.username ?? "",
                        details: {
                            tagline: details.tagline ?? "",
                            summary: details.summary ?? "",
                            quote: details.quote ?? "",
                        },
                    };
                } catch (error) {
                    elizaLogger.warn("Failed to parse actor details:", {
                        actorId: row.id,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });

                    return {
                        id: row.id as UUID,
                        name: row.name ?? "",
                        username: row.username ?? "",
                        details: {
                            tagline: "",
                            summary: "",
                            quote: "",
                        },
                    };
                }
            });
        } catch (error) {
            elizaLogger.error("Failed to fetch actor details:", {
                roomId: params.roomId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        try {
            return await this.searchMemoriesByEmbedding(params.embedding, {
                match_threshold: params.match_threshold,
                count: params.match_count,
                agentId: params.agentId,
                roomId: params.roomId,
                unique: params.unique,
                tableName: params.tableName,
            });
        } catch (error) {
            elizaLogger.error("Failed to search memories:", {
                error: error instanceof Error ? error.message : String(error),
                tableName: params.tableName,
                agentId: params.agentId,
                roomId: params.roomId,
            });
            throw error;
        }
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        try {
            await this.db
                .update(goalTable)
                .set({ status: params.status })
                .where(eq(goalTable.id, params.goalId));

            elizaLogger.debug("Updated goal status:", {
                goalId: params.goalId,
                newStatus: params.status,
            });
        } catch (error) {
            elizaLogger.error("Failed to update goal status:", {
                error: error instanceof Error ? error.message : String(error),
                goalId: params.goalId,
                status: params.status,
            });
            throw error;
        }
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        try {
            const cleanVector = embedding.map((n) =>
                Number.isFinite(n) ? Number(n.toFixed(6)) : 0
            );

            const similarity = sql<number>`1 - (${cosineDistance(
                memoryTable.embedding,
                cleanVector
            )})`;

            const conditions = [eq(memoryTable.type, params.tableName)];

            if (params.unique) {
                conditions.push(eq(memoryTable.unique, true));
            }
            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }
            if (params.roomId) {
                conditions.push(eq(memoryTable.roomId, params.roomId));
            }

            if (params.match_threshold) {
                conditions.push(gte(similarity, params.match_threshold));
            }

            const results = await this.db
                .select({
                    id: memoryTable.id,
                    type: memoryTable.type,
                    createdAt: memoryTable.createdAt,
                    content: memoryTable.content,
                    embedding: memoryTable.embedding,
                    userId: memoryTable.userId,
                    agentId: memoryTable.agentId,
                    roomId: memoryTable.roomId,
                    unique: memoryTable.unique,
                    similarity: similarity,
                })
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(similarity))
                .limit(params.count ?? 10);

            return results.map((row) => ({
                id: row.id as UUID,
                type: row.type,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
                similarity: row.similarity,
            }));
        } catch (error) {
            elizaLogger.error("Failed to search memories by embedding:", {
                error: error instanceof Error ? error.message : String(error),
                vectorLength: embedding.length,
                tableName: params.tableName,
                roomId: params.roomId,
                agentId: params.agentId,
            });
            throw error;
        }
    }

    async createMemory(
        memory: Memory,
        tableName: string,
        unique?: boolean
    ): Promise<void> {
        try {
            elizaLogger.info("DrizzleAdapter createMemory:", {
                memoryId: memory.id,
                embeddingLength: memory.embedding?.length,
                contentLength: memory.content?.text?.length,
            });

            let isUnique = true;
            if (memory.embedding) {
                elizaLogger.info("Searching for similar memories:");
                const similarMemories = await this.searchMemoriesByEmbedding(
                    memory.embedding,
                    {
                        tableName,
                        roomId: memory.roomId,
                        match_threshold: 0.95,
                        count: 1,
                    }
                );
                isUnique = similarMemories.length === 0;
            }

            const contentToInsert =
                typeof memory.content === "string"
                    ? JSON.parse(memory.content)
                    : memory.content;

            await this.db.insert(memoryTable).values([
                {
                    id: memory.id ?? uuid(),
                    type: tableName,
                    content: sql`${contentToInsert}::jsonb`,
                    embedding: memory.embedding,
                    userId: memory.userId,
                    roomId: memory.roomId,
                    agentId: memory.agentId,
                    unique: memory.unique ?? isUnique,
                    createdAt: memory.createdAt,
                },
            ]);
        } catch (error) {
            elizaLogger.debug("Error in createMemory:", error);
            elizaLogger.error("Failed to create memory:", {
                error: error instanceof Error ? error.message : String(error),
                memoryId: memory.id,
                tableName,
                roomId: memory.roomId,
            });
            throw error;
        }
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        try {
            await this.db
                .delete(memoryTable)
                .where(
                    and(
                        eq(memoryTable.id, memoryId),
                        eq(memoryTable.type, tableName)
                    )
                );

            elizaLogger.debug("Memory removed successfully:", {
                memoryId,
                tableName,
            });
        } catch (error) {
            elizaLogger.error("Failed to remove memory:", {
                error: error instanceof Error ? error.message : String(error),
                memoryId,
                tableName,
            });
            throw error;
        }
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        try {
            await this.db
                .delete(memoryTable)
                .where(
                    and(
                        eq(memoryTable.roomId, roomId),
                        eq(memoryTable.type, tableName)
                    )
                );

            elizaLogger.debug("All memories removed successfully:", {
                roomId,
                tableName,
            });
        } catch (error) {
            elizaLogger.error("Failed to remove all memories:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
                tableName,
            });
            throw error;
        }
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) throw new Error("tableName is required");

        try {
            const conditions = [
                eq(memoryTable.roomId, roomId),
                eq(memoryTable.type, tableName),
            ];

            if (unique) {
                conditions.push(eq(memoryTable.unique, true));
            }

            const result = await this.db
                .select({ count: sql<number>`count(*)` })
                .from(memoryTable)
                .where(and(...conditions));

            return Number(result[0]?.count ?? 0);
        } catch (error) {
            elizaLogger.error("Failed to count memories:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
                tableName,
                unique,
            });
            throw error;
        }
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        try {
            const conditions = [eq(goalTable.roomId, params.roomId)];

            if (params.userId) {
                conditions.push(eq(goalTable.userId, params.userId));
            }

            if (params.onlyInProgress) {
                conditions.push(
                    eq(goalTable.status, "IN_PROGRESS" as GoalStatus)
                );
            }

            const query = this.db
                .select()
                .from(goalTable)
                .where(and(...conditions))
                .orderBy(desc(goalTable.createdAt));

            const result = await (params.count
                ? query.limit(params.count)
                : query);

            return result.map((row) => ({
                id: row.id as UUID,
                roomId: row.roomId as UUID,
                userId: row.userId as UUID,
                name: row.name ?? "",
                status: (row.status ?? "NOT_STARTED") as GoalStatus,
                description: row.description ?? "",
                objectives: row.objectives as any[],
                createdAt: row.createdAt,
            }));
        } catch (error) {
            elizaLogger.error("Failed to get goals:", {
                error: error instanceof Error ? error.message : String(error),
                roomId: params.roomId,
                userId: params.userId,
                onlyInProgress: params.onlyInProgress,
            });
            throw error;
        }
    }

    async updateGoal(goal: Goal): Promise<void> {
        try {
            await this.db
                .update(goalTable)
                .set({
                    name: goal.name,
                    status: goal.status,
                    objectives: goal.objectives,
                })
                .where(eq(goalTable.id, goal.id as string));
        } catch (error) {
            elizaLogger.error("Failed to update goal:", {
                error: error instanceof Error ? error.message : String(error),
                goalId: goal.id,
                status: goal.status,
            });
            throw error;
        }
    }

    async createGoal(goal: Goal): Promise<void> {
        try {
            await this.db.insert(goalTable).values({
                id: goal.id ?? uuid(),
                roomId: goal.roomId,
                userId: goal.userId,
                name: goal.name,
                status: goal.status,
                objectives: sql`${goal.objectives}::jsonb`,
            });
        } catch (error) {
            elizaLogger.error("Failed to create goal:", {
                error: error instanceof Error ? error.message : String(error),
                goalId: goal.id,
            });
            throw error;
        }
    }

    async removeGoal(goalId: UUID): Promise<void> {
        if (!goalId) throw new Error("Goal ID is required");

        try {
            await this.db.delete(goalTable).where(eq(goalTable.id, goalId));

            elizaLogger.debug("Goal removal attempt:", {
                goalId,
                removed: true,
            });
        } catch (error) {
            elizaLogger.error("Failed to remove goal:", {
                error: error instanceof Error ? error.message : String(error),
                goalId,
            });
            throw error;
        }
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        try {
            await this.db.delete(goalTable).where(eq(goalTable.roomId, roomId));
        } catch (error) {
            elizaLogger.error("Failed to remove all goals:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
            });
            throw error;
        }
    }

    async getRoom(roomId: UUID): Promise<UUID | null> {
        try {
            const result = await this.db
                .select({
                    id: roomTable.id,
                })
                .from(roomTable)
                .where(eq(roomTable.id, roomId))
                .limit(1);

            return (result[0]?.id as UUID) ?? null;
        } catch (error) {
            elizaLogger.error("Failed to get room:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
            });
            throw error;
        }
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        try {
            const id = roomId ?? uuid();

            await this.db.insert(roomTable).values([
                {
                    id: id as string,
                },
            ]);

            return id as UUID;
        } catch (error) {
            elizaLogger.error("Failed to create room:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
            });
            throw error;
        }
    }

    async removeRoom(roomId: UUID): Promise<void> {
        try {
            await this.db.delete(roomTable).where(eq(roomTable.id, roomId));
        } catch (error) {
            elizaLogger.error("Failed to remove room:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
            });
            throw error;
        }
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        const result = await this.db
            .select({ roomId: participantTable.roomId })
            .from(participantTable)
            .where(eq(participantTable.userId, userId));

        return result.map((row) => row.roomId as UUID);
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        const result = await this.db
            .selectDistinct({ roomId: participantTable.roomId })
            .from(participantTable)
            .where(inArray(participantTable.userId, userIds));

        return result.map((row) => row.roomId as UUID);
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            await this.db.insert(participantTable).values({
                id: uuid(),
                userId,
                roomId,
            });
            return true;
        } catch (error) {
            elizaLogger.error("Failed to add participant:", {
                error: error instanceof Error ? error.message : String(error),
                userId,
                roomId,
            });
            return false;
        }
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            const result = await this.db
                .delete(participantTable)
                .where(
                    and(
                        eq(participantTable.userId, userId),
                        eq(participantTable.roomId, roomId)
                    )
                )
                .returning();

            return result.length > 0;
        } catch (error) {
            elizaLogger.error("Failed to remove participant:", {
                error: error instanceof Error ? error.message : String(error),
                userId,
                roomId,
            });
            throw error;
        }
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        try {
            const result = await this.db
                .select({
                    id: participantTable.id,
                    userId: participantTable.userId,
                    roomId: participantTable.roomId,
                    lastMessageRead: participantTable.lastMessageRead,
                })
                .from(participantTable)
                .where(eq(participantTable.userId, userId));

            const account = await this.getAccountById(userId);

            return result.map((row) => ({
                id: row.id as UUID,
                account: account!,
            }));
        } catch (error) {
            elizaLogger.error("Failed to get participants for account:", {
                error: error instanceof Error ? error.message : String(error),
                userId,
            });
            throw error;
        }
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        try {
            const result = await this.db
                .select({ userId: participantTable.userId })
                .from(participantTable)
                .where(eq(participantTable.roomId, roomId));

            return result.map((row) => row.userId as UUID);
        } catch (error) {
            elizaLogger.error("Failed to get participants for room:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
            });
            throw error;
        }
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        try {
            const result = await this.db
                .select({ userState: participantTable.userState })
                .from(participantTable)
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.userId, userId)
                    )
                )
                .limit(1);

            return (
                (result[0]?.userState as "FOLLOWED" | "MUTED" | null) ?? null
            );
        } catch (error) {
            elizaLogger.error("Failed to get participant user state:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
                userId,
            });
            throw error;
        }
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        try {
            await this.db
                .update(participantTable)
                .set({ userState: state })
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.userId, userId)
                    )
                );
        } catch (error) {
            elizaLogger.error("Failed to set participant user state:", {
                error: error instanceof Error ? error.message : String(error),
                roomId,
                userId,
                state,
            });
            throw error;
        }
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        try {
            const relationshipId = uuid();
            await this.db.insert(relationshipTable).values({
                id: relationshipId,
                userA: params.userA,
                userB: params.userB,
                userId: params.userA,
            });

            elizaLogger.debug("Relationship created successfully:", {
                relationshipId,
                userA: params.userA,
                userB: params.userB,
            });

            return true;
        } catch (error) {
            if ((error as { code?: string }).code === "23505") {
                elizaLogger.warn("Relationship already exists:", {
                    userA: params.userA,
                    userB: params.userB,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                return false;
            }

            elizaLogger.error("Failed to create relationship:", {
                error: error instanceof Error ? error.message : String(error),
                userA: params.userA,
                userB: params.userB,
            });
            return false;
        }
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        try {
            const result = await this.db
                .select()
                .from(relationshipTable)
                .where(
                    or(
                        and(
                            eq(relationshipTable.userA, params.userA),
                            eq(relationshipTable.userB, params.userB)
                        ),
                        and(
                            eq(relationshipTable.userA, params.userB),
                            eq(relationshipTable.userB, params.userA)
                        )
                    )
                )
                .limit(1);

            if (result.length > 0) {
                return result[0] as unknown as Relationship;
            }

            elizaLogger.debug("No relationship found between users:", {
                userA: params.userA,
                userB: params.userB,
            });
            return null;
        } catch (error) {
            elizaLogger.error("Error fetching relationship:", {
                error: error instanceof Error ? error.message : String(error),
                userA: params.userA,
                userB: params.userB,
            });
            throw error;
        }
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        try {
            const result = await this.db
                .select()
                .from(relationshipTable)
                .where(
                    or(
                        eq(relationshipTable.userA, params.userId),
                        eq(relationshipTable.userB, params.userId)
                    )
                )
                .orderBy(desc(relationshipTable.createdAt));

            elizaLogger.debug("Retrieved relationships:", {
                userId: params.userId,
                count: result.length,
            });

            return result as unknown as Relationship[];
        } catch (error) {
            elizaLogger.error("Failed to fetch relationships:", {
                error: error instanceof Error ? error.message : String(error),
                userId: params.userId,
            });
            throw error;
        }
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        try {
            let conditions = [
                or(
                    eq(knowledgeTable.agentId, params.agentId),
                    eq(knowledgeTable.isShared, true)
                ),
            ];

            if (params.id) {
                conditions.push(eq(knowledgeTable.id, params.id));
            }

            const query = this.db
                .select()
                .from(knowledgeTable)
                .where(and(...conditions))
                .orderBy(desc(knowledgeTable.createdAt));

            const result = await (params.limit
                ? query.limit(params.limit)
                : query);

            return result.map((row) => ({
                id: row.id as UUID,
                agentId: row.agentId as UUID,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding
                    ? new Float32Array(row.embedding)
                    : undefined,
                createdAt: row.createdAt,
            }));
        } catch (error) {
            elizaLogger.error("Failed to get knowledge:", {
                error: error instanceof Error ? error.message : String(error),
                id: params.id,
                agentId: params.agentId,
                limit: params.limit,
            });
            throw error;
        }
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        try {
            const cacheKey = `embedding_${params.agentId}_${params.searchText}`;

            const cachedResult = await this.getCache({
                key: cacheKey,
                agentId: params.agentId,
            });

            if (cachedResult) {
                return JSON.parse(cachedResult);
            }

            const vectorStr = params.embedding
                ? `[${Array.from(params.embedding).join(",")}]`
                : null;

            const searchPattern = `%${params.searchText || ""}%`;

            const result = await this.db.execute<Record<string, unknown>>(sql`
                WITH vector_scores AS (
                    SELECT id,
                        1 - (embedding <-> ${vectorStr}::vector) as vector_score
                    FROM knowledge
                    WHERE ("agentId" IS NULL AND "isShared" = true) OR "agentId" = ${params.agentId}
                    AND embedding IS NOT NULL
                ),
                keyword_matches AS (
                    SELECT id,
                    CASE
                        WHEN content->>'text' ILIKE ${searchPattern} THEN 3.0
                        ELSE 1.0
                    END *
                    CASE
                        WHEN (content->'metadata'->>'isChunk')::boolean = true THEN 1.5
                        WHEN (content->'metadata'->>'isMain')::boolean = true THEN 1.2
                        ELSE 1.0
                    END as keyword_score
                    FROM knowledge
                    WHERE ("agentId" IS NULL AND "isShared" = true) OR "agentId" = ${params.agentId}
                )
                SELECT k.*,
                    v.vector_score,
                    kw.keyword_score,
                    (v.vector_score * kw.keyword_score) as combined_score
                FROM knowledge k
                JOIN vector_scores v ON k.id = v.id
                LEFT JOIN keyword_matches kw ON k.id = kw.id
                WHERE ("agentId" IS NULL AND "isShared" = true) OR k."agentId" = ${params.agentId}
                AND (
                    v.vector_score >= ${params.match_threshold}
                    OR (kw.keyword_score > 1.0 AND v.vector_score >= 0.3)
                )
                ORDER BY combined_score DESC
                LIMIT ${params.match_count}
            `);

            const mappedResults = result.rows.map((row: any) => ({
                id: row.id,
                agentId: row.agentId,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding
                    ? new Float32Array(row.embedding)
                    : undefined,
                createdAt: row.createdAt,
                similarity: row.combined_score,
            }));

            await this.setCache({
                key: cacheKey,
                agentId: params.agentId,
                value: JSON.stringify(mappedResults),
            });

            return mappedResults;
        } catch (error) {
            elizaLogger.error("Error in searchKnowledge:", {
                error: error instanceof Error ? error.message : String(error),
                agentId: params.agentId,
                searchText: params.searchText,
            });
            throw error;
        }
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        await this.db.transaction(async (tx) => {
            try {
                const metadata = knowledge.content.metadata || {};

                if (metadata.isChunk && metadata.originalId) {
                    await this.createKnowledgeChunk({
                        id: knowledge.id,
                        originalId: metadata.originalId,
                        agentId: metadata.isShared ? null : knowledge.agentId,
                        content:
                            typeof knowledge.content === "string"
                                ? JSON.parse(knowledge.content)
                                : knowledge.content,
                        embedding: knowledge.embedding,
                        chunkIndex: metadata.chunkIndex || 0,
                        isShared: metadata.isShared || false,
                        createdAt: knowledge.createdAt || Date.now(),
                    });
                } else {
                    await tx.insert(knowledgeTable).values({
                        id: knowledge.id,
                        agentId: metadata.isShared ? null : knowledge.agentId,
                        content: sql`${
                            typeof knowledge.content === "string"
                                ? JSON.parse(knowledge.content)
                                : knowledge.content
                        }::jsonb`,
                        embedding: knowledge.embedding
                            ? Array.from(knowledge.embedding)
                            : null,
                        isMain: true,
                        originalId: null,
                        chunkIndex: null,
                        isShared: metadata.isShared || false,
                        createdAt: knowledge.createdAt,
                    });
                }
            } catch (error) {
                elizaLogger.error("Failed to create knowledge:", error);
                throw error;
            }
        });
    }

    private async createKnowledgeChunk(params: {
        id: UUID;
        originalId: UUID;
        agentId: UUID | null;
        content: any;
        embedding: Float32Array | undefined | null;
        chunkIndex: number;
        isShared: boolean;
        createdAt: number;
    }): Promise<void> {
        const embedding = params.embedding
            ? Array.from(params.embedding)
            : null;

        const patternId = `${params.originalId}-chunk-${params.chunkIndex}`;
        const contentWithPatternId = {
            ...params.content,
            metadata: {
                ...params.content.metadata,
                patternId,
            },
        };

        await this.db.insert(knowledgeTable).values({
            id: params.id,
            agentId: params.agentId,
            content: sql`${contentWithPatternId}::jsonb`,
            embedding: embedding,
            isMain: false,
            originalId: params.originalId,
            chunkIndex: params.chunkIndex,
            isShared: params.isShared,
            createdAt: params.createdAt,
        });
    }

    async removeKnowledge(id: UUID): Promise<void> {
        try {
            await this.db
                .delete(knowledgeTable)
                .where(eq(knowledgeTable.id, id));
        } catch (error) {
            elizaLogger.error("Failed to remove knowledge:", {
                error: error instanceof Error ? error.message : String(error),
                id,
            });
            throw error;
        }
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        try {
            await this.db
                .delete(knowledgeTable)
                .where(eq(knowledgeTable.agentId, agentId));
        } catch (error) {
            elizaLogger.error("Failed to clear knowledge:", {
                error: error instanceof Error ? error.message : String(error),
                agentId,
                shared,
            });
            throw error;
        }
    }

    async getCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<string | undefined> {
        try {
            const result = await this.db
                .select()
                .from(cacheTable)
                .where(
                    and(
                        eq(cacheTable.agentId, params.agentId),
                        eq(cacheTable.key, params.key)
                    )
                );

            return result[0]?.value || undefined;
        } catch (error) {
            elizaLogger.error("Failed to get cache:", {
                error: error instanceof Error ? error.message : String(error),
                agentId: params.agentId,
                key: params.key,
            });
            throw error;
        }
    }

    async setCache(params: {
        agentId: UUID;
        key: string;
        value: string;
    }): Promise<boolean> {
        try {
            await this.db
                .insert(cacheTable)
                .values({
                    key: params.key,
                    agentId: params.agentId,
                    value: sql`${params.value}::jsonb`,
                })
                .onConflictDoUpdate({
                    target: [cacheTable.key, cacheTable.agentId],
                    set: {
                        value: params.value,
                    },
                });
            return true;
        } catch (error) {
            elizaLogger.error("Error setting cache", {
                error: error instanceof Error ? error.message : String(error),
                key: params.key,
                agentId: params.agentId,
            });
            return false;
        }
    }

    async deleteCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<boolean> {
        try {
            await this.db
                .delete(cacheTable)
                .where(
                    and(
                        eq(cacheTable.agentId, params.agentId),
                        eq(cacheTable.key, params.key)
                    )
                );
            return true;
        } catch (error) {
            elizaLogger.error("Error deleting cache", {
                error: error instanceof Error ? error.message : String(error),
                key: params.key,
                agentId: params.agentId,
            });
            return false;
        }
    }
}
