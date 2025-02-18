// src/commands/character.ts
import type { Character, MessageExample, UUID } from "@elizaos/core";
import { MessageExampleSchema } from "@elizaos/core";
import { Command } from "commander";
import fs from "node:fs";
import prompts from "prompts";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { adapter } from "../database";
import { handleError } from "../utils/handle-error";
import { logger } from "../utils/logger";
import { availablePlugins } from "../plugins";

let isShuttingDown = false;

const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("\nOperation cancelled by user. Cleaning up...");
    try {
        await adapter.close();
        logger.info("Database connection closed successfully.");
    } catch (error) {
        logger.error("Error while closing database connection:", error);
    }
    process.exitCode = 1;

    setTimeout(() => {
        logger.warn("Forcing process termination after timeout");
        process.exit(1);
    }, 1000);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function withConnection(action: () => Promise<void>) {
    let initialized = false;
    try {
        adapter.init();
        initialized = true;
        await action();
    } catch (error) {
        if (!isShuttingDown) {
            logger.error("Error during command execution:", error);
        }
        throw error;
    } finally {
        if (initialized && !isShuttingDown) {
            try {
                await adapter.close();
            } catch (error) {
                logger.error("Error while closing database connection:", error);
            }
        }
    }
}

const characterSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string(),
    username: z.string(),
    plugins: z.array(z.string()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    bio: z.array(z.string()).optional(),
    adjectives: z.array(z.string()).optional(),
    postExamples: z.array(z.string()).optional(),
    messageExamples: z.array(z.array(MessageExampleSchema)).optional(),
    topics: z.array(z.string()).optional(),
    style: z
        .object({
            all: z.array(z.string()).optional(),
            chat: z.array(z.string()).optional(),
            post: z.array(z.string()).optional(),
        })
        .optional(),
});

type CharacterFormData = z.infer<typeof characterSchema>;

export const character = new Command()
    .name("character")
    .description("manage characters");

const NAV_BACK = "__back__";
const NAV_NEXT = "__next__";

/**
 * Prompt helper with navigation.
 * Short instructions: type "back", "next" or "cancel".
 */
async function promptWithNav(
    label: string,
    initial = "",
    validate?: (val: string) => true | string
): Promise<string> {
    const msg = `${label}${initial ? ` (current: ${initial})` : ""}`;
    const res = await prompts({
        type: "text",
        name: "value",
        message: msg,
        initial,
        validate,
    });
    const input = res.value !== undefined ? res.value.trim() : "";
    if (input.toLowerCase() === "cancel") return "cancel";
    if (input.toLowerCase() === "back") return NAV_BACK;
    if (input === "" && initial) return initial; // Return initial value if empty input
    if (input === "" || input.toLowerCase() === "next") return NAV_NEXT;
    return input;
}

/**
 * Prompt for multiple items (one by one).
 */
async function promptForMultipleItems(
    fieldName: string,
    initial: string[] = []
): Promise<string[]> {
    const items = [...initial];
    logger.info(`\n${fieldName}`);
    if (initial.length > 0) {
        logger.info("Current values:");
        initial.forEach((item, i) => logger.info(`  ${i + 1}. ${item}`));
        logger.info(
            "\nPress Enter to keep existing values, or start typing new ones:"
        );
    }

    while (true) {
        const val = await promptWithNav(`> ${fieldName}:`);
        if (val === NAV_NEXT) break;
        if (val === NAV_BACK) {
            if (items.length === initial.length) return initial; // Return original values if no changes
            break;
        }
        if (val === "cancel") return initial;
        items.push(val);
    }
    return items;
}

/**
 * Collects a conversation example.
 * Messages alternate starting with the user.
 */
async function collectSingleConversation(
    characterName: string,
    initial?: MessageExample[]
): Promise<MessageExample[] | null> {
    const msgs: MessageExample[] = [...(initial || [])];
    let role: "user" | "character" = initial?.length
        ? initial[initial.length - 1].user === characterName
            ? "user"
            : "character"
        : "user";

    logger.info("\nEnter conversation messages (alternating user/character)");
    if (initial?.length) {
        logger.info("\nExisting conversation:");
        initial.forEach((msg) => {
            const user = msg.user === "{{user1}}" ? "User" : msg.user;
            logger.info(`${user}: ${msg.content.text}`);
        });
        logger.info(
            "\nContinue the conversation or press Enter to keep as is:"
        );
    } else {
        logger.info(
            "Press Enter with empty input or type 'next' when done with the conversation"
        );
        logger.info("Type 'cancel' to discard this conversation");
    }

    while (true) {
        const label =
            role === "user" ? "User Message" : `${characterName} Response`;
        const input = await promptWithNav(label, "", (val) =>
            role === "user" || val ? true : "Enter a message"
        );
        if (input === "cancel") return initial || null;
        if (input === NAV_NEXT) {
            if (msgs.length === 0) {
                logger.info(
                    "At least one message is required. Type 'cancel' to skip message examples entirely."
                );
                continue;
            }
            break;
        }
        if (input === NAV_BACK) continue;
        msgs.push({
            user: role === "user" ? "{{user1}}" : characterName,
            content: { text: input },
        });
        role = role === "user" ? "character" : "user";
    }
    return msgs.length > 0 ? msgs : null;
}

/**
 * Collect multiple conversation examples.
 */
async function collectMessageExamples(
    characterName: string,
    initial: MessageExample[][] = []
): Promise<MessageExample[][]> {
    const examples: MessageExample[][] = [...initial];
    logger.info("\nMessage Examples");

    if (initial.length > 0) {
        logger.info(`\nExisting conversations (${initial.length}):`);
        logger.info(formatMessageExamples(initial));
        logger.info(
            "\nPress Enter to keep existing conversations, or add new ones:"
        );
    } else {
        logger.info(
            "Enter example conversations to demonstrate the character's communication style"
        );
    }

    while (true) {
        const convo = await collectSingleConversation(characterName);
        if (!convo) {
            if (examples.length === initial.length) return initial;
            break;
        }
        examples.push(convo);
        logger.info(`Added conversation with ${convo.length} messages`);

        const { addMore } = await prompts({
            type: "confirm",
            name: "addMore",
            message: "Add another conversation?",
            initial: true,
        });
        if (!addMore) break;
    }

    logger.info(`Total conversations: ${examples.length}`);
    return examples;
}

/**
 * Collect character data with navigation.
 */
async function collectCharacterData(
    initialData?: Partial<CharacterFormData>
): Promise<CharacterFormData | null> {
    const data: Partial<CharacterFormData> = { ...initialData };
    logger.info("\n=== Create Your Character ===");
    logger.info("Navigation Instructions:");
    logger.info("- Press Enter or type 'next' to move forward");
    logger.info("- Type 'back' to go to previous field");
    logger.info("- Type 'cancel' to abort at any time");
    logger.info("----------------------------------------\n");

    type Field = {
        key: keyof CharacterFormData;
        prompt: () => Promise<
            "success" | typeof NAV_BACK | typeof NAV_NEXT | "cancel"
        >;
    };
    const fields: Field[] = [
        {
            key: "name",
            prompt: async () => {
                const inp = await promptWithNav(
                    "Name:",
                    data.name || "",
                    (val) => (val.length >= 2 ? true : "Min 2 chars")
                );
                if (inp === "cancel") return "cancel";
                if (inp === NAV_BACK) return NAV_BACK;
                if (inp === NAV_NEXT) return NAV_NEXT;
                data.name = inp;
                data.username = inp.toLowerCase().replace(/\s+/g, "_");
                return "success";
            },
        },
        {
            key: "bio",
            prompt: async () => {
                const items = await promptForMultipleItems(
                    "Bio",
                    data.bio || []
                );
                data.bio = items;
                return "success";
            },
        },
        {
            key: "adjectives",
            prompt: async () => {
                const items = await promptForMultipleItems(
                    "Adjectives",
                    data.adjectives || []
                );
                if (items.length < 3) {
                    logger.error("Require at least 3 adjectives.");
                    return await fields[2].prompt();
                }
                data.adjectives = items;
                return "success";
            },
        },
        {
            key: "topics",
            prompt: async () => {
                const items = await promptForMultipleItems(
                    "Topics",
                    data.topics || []
                );
                data.topics = items;
                return "success";
            },
        },
        {
            key: "plugins",
            prompt: async () => {
                const pluginChoices = Object.keys(availablePlugins).map(
                    (plugin) => ({
                        title: plugin,
                        value: plugin,
                        selected: data.plugins?.includes(plugin) || false,
                    })
                );

                if (pluginChoices.length === 0) {
                    logger.info("\nNo plugins available");
                    data.plugins = [];
                    return "success";
                }

                logger.info("\nSelect plugins for your character:");
                logger.info(
                    "Use space to select/deselect, arrow keys to move, enter to confirm"
                );

                const { selectedPlugins } = await prompts({
                    type: "multiselect",
                    name: "selectedPlugins",
                    message: "Available plugins",
                    choices: pluginChoices,
                    hint: "Space to select/deselect, Enter to confirm",
                });

                if (selectedPlugins === undefined) {
                    logger.info(
                        "No plugins selected, continuing with empty plugins list"
                    );
                    data.plugins = [];
                    return "success";
                }
                data.plugins = selectedPlugins;
                logger.info(
                    `Selected plugins: ${selectedPlugins.join(", ") || "none"}`
                );
                return "success";
            },
        },
        {
            key: "postExamples",
            prompt: async () => {
                const items = await promptForMultipleItems(
                    "Post Examples",
                    data.postExamples || []
                );
                data.postExamples = items;
                return "success";
            },
        },
        {
            key: "style",
            prompt: async () => {
                data.style = data.style || {};
                const fieldsStyle: (keyof typeof data.style)[] = [
                    "all",
                    "chat",
                    "post",
                ];

                logger.info("\nDefine character's style traits:");
                logger.info("Enter one trait per line for each category");
                logger.info(
                    "Press Enter with empty input or type 'next' when done with a category"
                );
                logger.info("Type 'back' to return to previous category");

                for (const field of fieldsStyle) {
                    try {
                        logger.info(`\n${field.toUpperCase()} STYLE TRAITS:`);
                        if (field === "all") {
                            logger.info(
                                "These traits apply to all interactions"
                            );
                        } else if (field === "chat") {
                            logger.info(
                                "These traits apply only to chat/conversation interactions"
                            );
                        } else if (field === "post") {
                            logger.info(
                                "These traits apply only to social media posts"
                            );
                        }

                        const items = await promptForMultipleItems(
                            `${field} style`,
                            data.style[field] || []
                        );
                        data.style[field] = items || [];
                        logger.info(
                            `${field} style: ${items.length} traits added`
                        );
                    } catch {
                        logger.error(
                            `Error in ${field} style input, skipping...`
                        );
                        data.style[field] = [];
                    }
                }
                return "success";
            },
        },
        {
            key: "messageExamples",
            prompt: async () => {
                // Ensure message examples match the required type structure
                const existingExamples = (data.messageExamples || []).map(
                    (conversation) =>
                        conversation.map((msg) => ({
                            user: msg.user || "unknown",
                            content: {
                                text: msg.content?.text || "",
                                ...msg.content,
                            },
                        }))
                ) as MessageExample[][];
                const exs = await collectMessageExamples(
                    data.name || "",
                    existingExamples
                );
                data.messageExamples = exs;
                return "success";
            },
        },
    ];

    let idx = 0;
    while (idx < fields.length) {
        const res = await fields[idx].prompt();
        if (res === "cancel") {
            logger.info("Creation cancelled");
            return null;
        }
        if (res === NAV_BACK) {
            if (idx > 0) idx--;
            else logger.info("First field");
        } else {
            idx++;
        }
    }
    return data as CharacterFormData;
}

function getDefaultCharacterFields(existing?: Partial<Character>) {
    return {
        topics: existing?.topics || [],
        style: {
            all: existing?.style?.all || [],
            chat: existing?.style?.chat || [],
            post: existing?.style?.post || [],
        },
        plugins: existing?.plugins || [],
    };
}

/**
 * Format message examples into readable conversation format
 */
function formatMessageExamples(examples: MessageExample[][]): string {
    if (!examples || examples.length === 0) return "No message examples";

    return examples
        .map((conversation, i) => {
            const messages = conversation
                .map((msg) => {
                    const user = msg.user === "{{user1}}" ? "User" : msg.user;
                    return `  ${user}: ${msg.content.text}`;
                })
                .join("\n");
            return `\nConversation ${i + 1}:\n${messages}`;
        })
        .join("\n");
}

/**
 * Display character data
 */
function displayCharacter(
    data: Partial<Character>,
    title = "Character Review"
): void {
    logger.info(`\n=== ${title} ===`);

    // Display basic info
    logger.info(`Name: ${data.name}`);
    logger.info(
        `Username: ${
            data.username || data.name?.toLowerCase().replace(/\s+/g, "_")
        }`
    );

    // Display bio
    logger.info("\nBio:");
    for (const line of Array.isArray(data.bio) ? data.bio : [data.bio]) {
        logger.info(`  ${line}`);
    }

    // Display adjectives
    logger.info("\nAdjectives:");
    for (const adj of data.adjectives || []) {
        logger.info(`  ${adj}`);
    }

    // Display topics
    if (data.topics && data.topics.length > 0) {
        logger.info("\nTopics:");
        for (const topic of data.topics) {
            logger.info(`  ${topic}`);
        }
    }

    // Display plugins
    if (data.plugins && data.plugins.length > 0) {
        logger.info("\nPlugins:");
        for (const plugin of data.plugins) {
            logger.info(`  ${plugin}`);
        }
    }

    // Display style
    if (data.style) {
        if (data.style.all && data.style.all.length > 0) {
            logger.info("\nGeneral Style:");
            for (const style of data.style.all) {
                logger.info(`  ${style}`);
            }
        }
        if (data.style.chat && data.style.chat.length > 0) {
            logger.info("\nChat Style:");
            for (const style of data.style.chat) {
                logger.info(`  ${style}`);
            }
        }
        if (data.style.post && data.style.post.length > 0) {
            logger.info("\nPost Style:");
            for (const style of data.style.post) {
                logger.info(`  ${style}`);
            }
        }
    }

    // Display post examples
    if (data.postExamples && data.postExamples.length > 0) {
        logger.info("\nPost Examples:");
        for (const post of data.postExamples) {
            logger.info(`  ${post}`);
        }
    }

    // Display message examples
    if (data.messageExamples && data.messageExamples.length > 0) {
        logger.info("\nMessage Examples:");
        logger.info(formatMessageExamples(data.messageExamples));
    }
}

/**
 * Display character data for review and get confirmation
 */
async function reviewCharacter(data: Partial<Character>): Promise<boolean> {
    displayCharacter(data);

    const { confirmed } = await prompts({
        type: "confirm",
        name: "confirmed",
        message: "Save this character?",
        initial: true,
    });

    return confirmed;
}

//
// COMMAND ACTIONS
//

character
    .command("list")
    .description("list all characters")
    .action(async () => {
        return withConnection(async () => {
            const chars = await adapter.listCharacters();
            if (chars.length === 0) logger.info("No characters found");
            else {
                logger.info("\nCharacters:");
                console.table(
                    chars.map((c) => ({ name: c.name, bio: c.bio[0] }))
                );
            }
        });
    });

character
    .command("create")
    .description("create a new character")
    .action(async () => {
        return withConnection(async () => {
            const formData = await collectCharacterData();
            if (!formData) {
                logger.info("Creation cancelled");
                return;
            }
            const charData = {
                ...getDefaultCharacterFields(), // Default field values first in case of missing data
                name: formData.name,
                username: formData.username,
                bio: formData.bio,
                adjectives: formData.adjectives,
                postExamples: formData.postExamples,
                messageExamples: (formData.messageExamples || []).map(
                    (conversation) =>
                        conversation.map((msg) => ({
                            user: msg.user || "unknown", // Ensure user is never undefined
                            content: msg.content,
                        }))
                ),
                topics: formData.topics || [],
                plugins: formData.plugins || [],
                style: {
                    all: formData.style?.all || [],
                    chat: formData.style?.chat || [],
                    post: formData.style?.post || [],
                },
            } as Character; // Cast the entire object to Character type

            if (await reviewCharacter(charData)) {
                await adapter.createCharacter(charData);
                logger.success(`Created character ${formData.name}`);
            } else {
                logger.info("Creation cancelled");
            }
        });
    });

character
    .command("edit")
    .description("edit a character")
    .argument("<character-name>", "character name")
    .action(async (characterName) => {
        return withConnection(async () => {
            const existing = await adapter.getCharacter(characterName);
            if (!existing) {
                logger.error(`Character ${characterName} not found`);
                return;
            }

            // Show current values before editing
            displayCharacter(existing, "Current Character Values");

            logger.info("\n=== Starting Edit Mode ===");
            logger.info(
                "Press Enter to keep existing values, or type new ones"
            );
            logger.info(
                "Type 'back' to go to previous field, 'next' to skip to next field"
            );
            logger.info("Type 'cancel' to abort at any time\n");

            const formData = await collectCharacterData({
                name: existing.name,
                username: existing.username,
                bio: Array.isArray(existing.bio)
                    ? existing.bio
                    : [existing.bio],
                adjectives: existing.adjectives || [],
                postExamples: existing.postExamples || [],
                messageExamples: existing.messageExamples || [],
                topics: existing.topics || [],
                plugins: existing.plugins || [],
                style: {
                    all: existing.style?.all || [],
                    chat: existing.style?.chat || [],
                    post: existing.style?.post || [],
                },
            });
            if (!formData) {
                logger.info("Editing cancelled");
                return;
            }
            const updated = {
                ...getDefaultCharacterFields(existing), // Include existing data in defaults
                name: formData.name,
                bio: formData.bio || [],
                adjectives: formData.adjectives || [],
                postExamples: formData.postExamples || [],
                messageExamples: (formData.messageExamples || []).map(
                    (conversation) =>
                        conversation.map((msg) => ({
                            user: msg.user || "unknown", // Ensure user is never undefined
                            content: msg.content,
                        }))
                ),
                topics: formData.topics || [],
                plugins: formData.plugins || [],
                style: {
                    all: formData.style?.all || [],
                    chat: formData.style?.chat || [],
                    post: formData.style?.post || [],
                },
            } as Character; // Cast the entire object to Character type

            if (await reviewCharacter(updated)) {
                await adapter.updateCharacter(characterName, updated);
                logger.success(
                    `Updated character ${formData.name} successfully`
                );
            } else {
                logger.info("Update cancelled");
            }
        });
    });

character
    .command("import")
    .description("import a character from file")
    .argument("<file>", "JSON file path")
    .action(async (fileArg) => {
        return withConnection(async () => {
            try {
                const filePath =
                    fileArg || (await promptWithNav("Path to JSON file:"));
                if (!filePath || filePath === NAV_NEXT) {
                    logger.info("Import cancelled");
                    return;
                }
                const raw = await fs.promises.readFile(filePath, "utf8");
                const parsed = characterSchema.parse(JSON.parse(raw));
                await adapter.createCharacter({
                    name: parsed.name,
                    bio: parsed.bio || [],
                    adjectives: parsed.adjectives || [],
                    postExamples: parsed.postExamples || [],
                    messageExamples:
                        parsed.messageExamples as MessageExample[][],
                    topics: parsed.topics || [],
                    style: {
                        all: parsed.style?.all || [],
                        chat: parsed.style?.chat || [],
                        post: parsed.style?.post || [],
                    },
                    plugins: parsed.plugins || [],
                });
                logger.success(`Imported character ${parsed.name}`);
            } catch (error) {
                handleError(error);
            }
        });
    });

character
    .command("export")
    .description("export a character to file")
    .argument("<character-name>", "character name")
    .option("-o, --output <file>", "output file path")
    .action(async (characterName, opts) => {
        return withConnection(async () => {
            const characterData = await adapter.getCharacter(characterName);
            if (!characterData) {
                logger.error(`Character ${characterName} not found`);
                return;
            }
            const outputPath = opts.output || `${characterData.name}.json`;
            await fs.promises.writeFile(
                outputPath,
                JSON.stringify(characterData, null, 2)
            );
            logger.success(`Exported character to ${outputPath}`);
        });
    });

character
    .command("remove")
    .description("remove a character")
    .argument("<character-name>", "character name")
    .action(async (characterName) => {
        return withConnection(async () => {
            const exists = await adapter.getCharacter(characterName);
            if (!exists) {
                logger.error(`Character ${characterName} not found`);
                return;
            }
            await adapter.removeCharacter(characterName);
            logger.success(`Removed character ${characterName}`);
        });
    });
