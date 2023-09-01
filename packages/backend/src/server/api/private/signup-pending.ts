import { UserPendings, UserProfiles, Users } from "@/models/index.js";
import type Koa from "koa";
import signin from "../common/signin.js";
import { signup } from "../common/signup.js";

export default async (ctx: Koa.Context) => {
	const body = ctx.request.body;

	const code = body.code;

	try {
		const pendingUser = await UserPendings.findOneByOrFail({ code });

		const { account, secret } = await signup({
			username: pendingUser.username,
			passwordHash: pendingUser.password,
		});

		UserPendings.delete({
			id: pendingUser.id,
		});

		const profile = await UserProfiles.findOneByOrFail({ userId: account.id });

		await UserProfiles.update(
			{ userId: profile.userId },
			{
				email: pendingUser.email,
				emailVerified: true,
				emailVerifyCode: null,
			},
		);

		signin(ctx, account);
	} catch (e) {
		ctx.throw(400, e);
	}
};
