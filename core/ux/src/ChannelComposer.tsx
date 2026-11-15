import { CHANNEL_LIMITS, type ChannelMember } from "@autonomo.us/common";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

type Picker = { start: number; query: string };
/** The `@word` the caret sits at the end of, if any. */
function mentionAt(text: string, caret: number): Picker | null {
	const match = /(?:^|\s)@([^\s@<>]{0,40})$/.exec(text.slice(0, caret));
	return match
		? { start: caret - match[1].length - 1, query: match[1].toLowerCase() }
		: null;
}
const PICKER_SIZE = 8;

/** A name the picker wrote into the box, and the mention it stands for. */
type Picked = { label: string; mention: string };
const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name touching one of these is part of a longer word, not the name. */
const WORD = "[\\p{L}\\p{M}\\p{N}_]";
/** Matches each picked `@Name` that stands on its own. */
function pickedPattern(picked: Picked[]): RegExp | null {
	if (picked.length === 0) return null;
	// Longest first, so `@Ada Lovelace` wins over `@Ada`.
	const labels = picked
		.map((pick) => pick.label)
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	return new RegExp(`(?<!${WORD})(?:${labels.join("|")})(?!${WORD})`, "gu");
}
/**
 * The text to post: each picked `@Name` becomes the mention the gateway
 * understands.
 */
export function writeMentions(text: string, picked: Picked[]): string {
	const pattern = pickedPattern(picked);
	if (!pattern) return text;
	const mentions = new Map(picked.map((pick) => [pick.label, pick.mention]));
	return text.replace(pattern, (label) => mentions.get(label) ?? label);
}

/**
 * The message box. Enter sends and Shift+Enter adds a line. Typing `@` opens
 * a picker of the channel's people and agents; choosing one writes `@Name`,
 * which becomes the mention the gateway understands when the message is sent.
 */
export function Composer({
	label,
	placeholder,
	members,
	disabledNote,
	onSend,
}: {
	label: string;
	placeholder: string;
	members: ChannelMember[];
	/** Why nothing can be posted; the box is disabled while set. */
	disabledNote?: string;
	onSend(body: string): void;
}) {
	const [text, setText] = useState("");
	const [picker, setPicker] = useState<Picker | null>(null);
	const [active, setActive] = useState(0);
	/** Where the picker was dismissed, so Escape keeps it closed for that `@`. */
	const dismissed = useRef(-1);
	/** Names chosen from the picker for this draft. */
	const picked = useRef<Picked[]>([]);
	const caret = useRef<number | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	const matches = picker
		? members
				.filter((member) => member.name.toLowerCase().includes(picker.query))
				.slice(0, PICKER_SIZE)
		: [];
	const open = matches.length > 0;
	const chosen = Math.min(active, matches.length - 1);

	const sync = (value: string, position: number) => {
		const next = mentionAt(value, position);
		if (!next) dismissed.current = -1;
		const shown = next && next.start !== dismissed.current ? next : null;
		if (shown?.query !== picker?.query) setActive(0);
		setPicker(shown);
	};
	const choose = (member: ChannelMember) => {
		if (!picker) return;
		const end = input.current?.selectionStart ?? text.length;
		const head = text.slice(0, picker.start);
		const after = text.slice(end);
		// Forget names no longer in the draft, so their label is free again.
		picked.current = picked.current.filter((pick) =>
			pickedPattern([pick])?.test(`${head} ${after}`),
		);
		let label = `@${member.name}`;
		const taken = picked.current.find((pick) => pick.label === label);
		if (!taken) picked.current.push({ label, mention: member.mention });
		// Two members with the same name in one draft: the name cannot tell
		// them apart, so the second is written as its mention.
		else if (taken.mention !== member.mention) label = member.mention;
		const before = `${head}${label} `;
		setText(before + after);
		caret.current = before.length;
		setPicker(null);
	};
	// Puts the caret after an inserted mention once the new text is in the box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each text change, when a caret move is waiting
	useEffect(() => {
		if (caret.current === null) return;
		input.current?.focus();
		input.current?.setSelectionRange(caret.current, caret.current);
		caret.current = null;
	}, [text]);
	const send = () => {
		const body = writeMentions(text, picked.current).trim();
		if (!body || disabledNote) return;
		onSend(body);
		setText("");
		setPicker(null);
		picked.current = [];
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
				setActive((chosen + step) % matches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				choose(matches[chosen]);
				return;
			}
		}
		if (event.key === "Escape" && picker) {
			event.preventDefault();
			dismissed.current = picker.start;
			setPicker(null);
			return;
		}
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			send();
		}
	};
	return (
		<form
			className="channel-composer"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			{open && (
				<div
					className="channel-mention-picker"
					id={listId}
					role="listbox"
					aria-label="Mention someone"
				>
					{matches.map((member, index) => (
						<div
							key={`${member.kind}:${member.id}`}
							id={`${listId}-${index}`}
							role="option"
							tabIndex={-1}
							aria-selected={index === chosen}
							// Mouse down, not click, so the message box keeps its focus.
							onMouseDown={(event) => {
								event.preventDefault();
								choose(member);
							}}
						>
							<span>{member.name}</span>
							{member.kind === "agent" && (
								<span className="channel-chip">Bot</span>
							)}
							{member.access === "read" && (
								<span className="field-hint">read only</span>
							)}
						</div>
					))}
				</div>
			)}
			<textarea
				ref={input}
				aria-label={label}
				aria-autocomplete="list"
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open ? `${listId}-${chosen}` : undefined}
				placeholder={disabledNote ? "" : placeholder}
				value={text}
				maxLength={CHANNEL_LIMITS.bodyLength}
				rows={Math.min(8, Math.max(1, text.split("\n").length))}
				disabled={Boolean(disabledNote)}
				onChange={(event) => {
					setText(event.target.value);
					sync(event.target.value, event.target.selectionStart);
				}}
				onSelect={(event) =>
					sync(event.currentTarget.value, event.currentTarget.selectionStart)
				}
				onBlur={() => setPicker(null)}
				onKeyDown={onKeyDown}
			/>
			<button
				className="button primary"
				type="submit"
				disabled={Boolean(disabledNote) || !text.trim()}
			>
				Send
			</button>
			<p className="field-hint channel-composer-hint">
				{disabledNote ??
					"Enter to send, Shift+Enter for a new line, @ to mention. Markdown and [[wikilinks]] work."}
			</p>
		</form>
	);
}
