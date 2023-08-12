import { expectType } from "tsd";
import * as Firefish from "../src";

describe("API", () => {
	test("success", async () => {
		const cli = new Firefish.api.APIClient({
			origin: "https://firefish.test",
			credential: "TOKEN",
		});
		const res = await cli.request("meta", { detail: true });
		expectType<Firefish.entities.DetailedInstanceMetadata>(res);
	});

	test("conditional respose type (meta)", async () => {
		const cli = new Firefish.api.APIClient({
			origin: "https://firefish.test",
			credential: "TOKEN",
		});

		const res = await cli.request("meta", { detail: true });
		expectType<Firefish.entities.DetailedInstanceMetadata>(res);

		const res2 = await cli.request("meta", { detail: false });
		expectType<Firefish.entities.LiteInstanceMetadata>(res2);

		const res3 = await cli.request("meta", {});
		expectType<Firefish.entities.LiteInstanceMetadata>(res3);

		const res4 = await cli.request("meta", { detail: true as boolean });
		expectType<
			| Firefish.entities.LiteInstanceMetadata
			| Firefish.entities.DetailedInstanceMetadata
		>(res4);
	});

	test("conditional respose type (users/show)", async () => {
		const cli = new Firefish.api.APIClient({
			origin: "https://firefish.test",
			credential: "TOKEN",
		});

		const res = await cli.request("users/show", { userId: "xxxxxxxx" });
		expectType<Firefish.entities.UserDetailed>(res);

		const res2 = await cli.request("users/show", { userIds: ["xxxxxxxx"] });
		expectType<Firefish.entities.UserDetailed[]>(res2);
	});
});
