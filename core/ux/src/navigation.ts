/**
 * Leaving the dashboard for another address. Kept behind an object so a test
 * can watch where the browser is sent without the page going anywhere.
 */
export const browser = {
	assign(url: string) {
		window.location.assign(url);
	},
};
