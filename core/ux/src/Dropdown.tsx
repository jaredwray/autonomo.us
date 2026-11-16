import { Select } from "@base-ui/react/select";
import {
	Children,
	type ComponentPropsWithRef,
	isValidElement,
	type ReactNode,
} from "react";

type Option = {
	value?: string | number;
	children?: ReactNode;
	disabled?: boolean;
};
type Props = Omit<
	ComponentPropsWithRef<"button">,
	"value" | "onChange" | "children"
> & {
	value: string | number;
	onValueChange(value: string): void;
	children: ReactNode;
	required?: boolean;
};

// Keep option declarations beside their business logic; Base UI owns interaction.
export function Dropdown({
	value,
	onValueChange,
	children,
	disabled,
	required,
	name,
	form,
	className = "",
	...trigger
}: Props) {
	const items = Children.toArray(children).flatMap((child) => {
		if (!isValidElement<Option>(child) || child.type !== "option") return [];
		const label = Children.toArray(child.props.children).join("");
		return [
			{
				value: String(child.props.value ?? label),
				label,
				disabled: child.props.disabled,
			},
		];
	});
	return (
		<Select.Root
			value={String(value)}
			onValueChange={(next) => {
				if (next !== null) onValueChange(next);
			}}
			items={items}
			disabled={disabled}
			required={required}
			name={name}
			form={form}
		>
			<Select.Trigger {...trigger} className={`dropdown-trigger ${className}`}>
				<Select.Value className="dropdown-value" />
				<Select.Icon className="dropdown-icon">
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						aria-hidden="true"
					>
						<path d="m6 9 6 6 6-6" />
					</svg>
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					className="dropdown-positioner"
					sideOffset={6}
					align="start"
					alignItemWithTrigger={false}
					collisionPadding={8}
				>
					<Select.Popup className="dropdown-popup">
						<Select.List className="dropdown-list">
							{items.map((item) => (
								<Select.Item
									key={item.value}
									value={item.value}
									disabled={item.disabled}
									className="dropdown-option"
									data-value={item.value}
								>
									<Select.ItemText>{item.label}</Select.ItemText>
									<Select.ItemIndicator
										className="dropdown-check"
										aria-hidden="true"
									>
										<svg
											width="16"
											height="16"
											viewBox="0 0 16 16"
											aria-hidden="true"
											fill="none"
											stroke="currentColor"
										>
											<path d="m3 8 3 3 7-7" />
										</svg>
									</Select.ItemIndicator>
								</Select.Item>
							))}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
