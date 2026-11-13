import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icons.js";

export type ModelOption = {
	id: string;
	name: string;
	/** `YYYY-MM-DD` or `YYYY-MM`, when the catalog reports one. */
	released?: string;
	/** USD per million tokens. */
	pricing?: { input: number; output: number };
};

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Room the open list needs below the field before it opens upward instead. */
const LIST_HEIGHT = 360;

function releasedLabel(released: string | undefined): string | null {
	const match = released?.match(/^(\d{4})-(\d{2})/);
	const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
	return match && month ? `${month} ${match[1]}` : null;
}

function priceLabel(pricing: ModelOption["pricing"]): string | null {
	if (!pricing) return null;
	if (pricing.input === 0 && pricing.output === 0) return "Free";
	const usd = (value: number) =>
		`$${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}`;
	return `${usd(pricing.input)} / ${usd(pricing.output)}`;
}

/**
 * Options whose id or name contains every word of the query, with the closest
 * ids first. Options that tie keep the catalog's order.
 */
function search(options: ModelOption[], query: string): ModelOption[] {
	const text = query.trim().toLowerCase();
	if (!text) return options;
	const words = text.split(/\s+/);
	const rank = (item: ModelOption) => {
		const id = item.id.toLowerCase();
		if (id === text) return 0;
		if (id.startsWith(text)) return 1;
		return 2;
	};
	return options
		.filter((item) => {
			const haystack = `${item.id} ${item.name}`.toLowerCase();
			return words.every((word) => haystack.includes(word));
		})
		.map((item, index) => ({ item, index, rank: rank(item) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item);
}

/**
 * The model field of the add-model form: a text box that takes any model id,
 * with the provider's catalog as a searchable list under it.
 */
export function ModelCombobox(props: {
	id: string;
	value: string;
	options: ModelOption[];
	/** Ids of the options already active on the selected connection. */
	activeIds: ReadonlySet<string>;
	describedBy?: string;
	onChange(value: string): void;
}) {
	const listId = useId();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	// The list narrows only while the person types. Reopening it on a chosen
	// model shows the whole catalog again, with that model marked.
	const [filtering, setFiltering] = useState(false);
	const [cursor, setCursor] = useState(-1);
	const [above, setAbove] = useState(false);
	const matches = filtering
		? search(props.options, props.value)
		: props.options;
	const shown = open && props.options.length > 0;
	const current = props.value.trim();

	const show = (startAt?: "first" | "last") => {
		if (props.options.length === 0) return;
		const rect = input.current?.getBoundingClientRect();
		if (rect) {
			const below = window.innerHeight - rect.bottom;
			setAbove(below < LIST_HEIGHT && rect.top > below);
		}
		const chosen = props.options.findIndex((item) => item.id === current);
		setFiltering(false);
		setCursor(
			chosen >= 0
				? chosen
				: startAt === "first"
					? 0
					: startAt === "last"
						? props.options.length - 1
						: -1,
		);
		setOpen(true);
	};
	const choose = (item: ModelOption) => {
		props.onChange(item.id);
		setOpen(false);
		setFiltering(false);
	};

	// Keeps the highlighted option inside the scrolling list.
	useEffect(() => {
		const box = list.current;
		const option = shown ? box?.children[cursor] : undefined;
		if (!box || !(option instanceof HTMLElement)) return;
		if (option.offsetTop < box.scrollTop) box.scrollTop = option.offsetTop;
		else if (
			option.offsetTop + option.offsetHeight >
			box.scrollTop + box.clientHeight
		)
			box.scrollTop = option.offsetTop + option.offsetHeight - box.clientHeight;
	}, [cursor, shown]);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (props.options.length === 0) return;
			event.preventDefault();
			const down = event.key === "ArrowDown";
			if (!shown) show(down ? "first" : "last");
			else if (matches.length > 0)
				setCursor(
					down
						? (cursor + 1) % matches.length
						: (Math.max(cursor, 0) + matches.length - 1) % matches.length,
				);
			return;
		}
		if (!shown) return;
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			return;
		}
		// Enter picks the highlighted option. With nothing highlighted it
		// submits the form with the id as typed.
		const option = matches[cursor];
		if (event.key === "Enter" && option && !event.nativeEvent.isComposing) {
			event.preventDefault();
			choose(option);
		}
	};

	return (
		<div className="model-combobox">
			<input
				id={props.id}
				ref={input}
				role="combobox"
				aria-expanded={shown}
				aria-controls={shown ? listId : undefined}
				aria-autocomplete="list"
				aria-activedescendant={
					shown && matches[cursor] ? `${listId}-${cursor}` : undefined
				}
				aria-describedby={props.describedBy}
				required
				autoComplete="off"
				autoCapitalize="none"
				spellCheck={false}
				data-1p-ignore
				data-lpignore="true"
				value={props.value}
				maxLength={200}
				placeholder={
					props.options.length > 0
						? "Search or enter a model ID"
						: "Enter a model ID"
				}
				onChange={(event) => {
					props.onChange(event.target.value);
					setFiltering(true);
					setCursor(-1);
					setOpen(true);
				}}
				onClick={() => {
					if (!shown) show();
				}}
				onKeyDown={onKeyDown}
				onBlur={() => setOpen(false)}
			/>
			{props.options.length > 0 ? (
				<button
					type="button"
					className="model-combobox-toggle"
					tabIndex={-1}
					aria-label={
						shown ? "Hide model suggestions" : "Show model suggestions"
					}
					// Mouse down, not click, so the model field keeps its focus.
					onMouseDown={(event) => {
						event.preventDefault();
						input.current?.focus();
						if (shown) setOpen(false);
						else show();
					}}
				>
					<Icon name="chevron" />
				</button>
			) : null}
			{shown ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: mouse down is stopped only so a click or scrollbar drag in the list does not blur the field and close it
				<div
					className={`model-combobox-popover${above ? " above" : ""}`}
					onMouseDown={(event) => event.preventDefault()}
				>
					{matches.length > 0 ? (
						<div
							className="model-combobox-list"
							id={listId}
							ref={list}
							role="listbox"
							aria-label="Model suggestions"
						>
							{matches.map((item, index) => {
								const price = priceLabel(item.pricing);
								const released = releasedLabel(item.released);
								return (
									<div
										key={item.id}
										id={`${listId}-${index}`}
										role="option"
										tabIndex={-1}
										aria-selected={index === cursor}
										data-current={item.id === current || undefined}
										onMouseDown={(event) => {
											event.preventDefault();
											choose(item);
										}}
										onMouseMove={() => {
											if (cursor !== index) setCursor(index);
										}}
									>
										<span className="model-option-main">
											<span className="model-option-name">
												{item.name}
												{props.activeIds.has(item.id) ? (
													<span className="model-option-tag">Active</span>
												) : null}
											</span>
											<code>{item.id}</code>
										</span>
										{price || released ? (
											<span className="model-option-meta">
												{price ? <span>{price}</span> : null}
												{released ? <span>{released}</span> : null}
											</span>
										) : null}
									</div>
								);
							})}
						</div>
					) : (
						<p className="model-combobox-empty" id={listId}>
							No suggestions match “{current}”. You can still add it as a custom
							model ID.
						</p>
					)}
					<p className="model-combobox-footer">
						<span role="status">
							{matches.length === props.options.length
								? `${matches.length} ${matches.length === 1 ? "model" : "models"}`
								: `${matches.length} of ${props.options.length} models`}
						</span>
						{props.options.some((item) => item.pricing) ? (
							<span>Price per 1M tokens, input / output</span>
						) : null}
					</p>
				</div>
			) : null}
		</div>
	);
}
