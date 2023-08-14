import {
	PrimaryColumn,
	Entity,
	Index,
	JoinColumn,
	Column,
	ManyToOne,
} from "typeorm";
import { Note } from "./note.js";
import { User } from "./user.js";
import { id } from "../id.js";

@Index(["userId", "noteId"], { unique: true })
class UserNotePiningBase {
	@PrimaryColumn(id())
	public id: string;

	@Column("timestamp with time zone", {
		comment: "The created date of the UserNotePinings.",
	})
	public createdAt: Date;

	@Index()
	@Column(id())
	public userId: User["id"];

	@ManyToOne((type) => User, {
		onDelete: "CASCADE",
	})
	@JoinColumn()
	public user: User | null;

	@Column(id())
	public noteId: Note["id"];
}

@Entity()
export class UserNotePining extends UserNotePiningBase {
	@ManyToOne((type) => Note, {
		onDelete: "CASCADE",
	})
	@JoinColumn()
	public note: Note | null;
}

@Entity({ name: "user_note_pining" })
export class UserNotePiningScylla extends UserNotePiningBase {}
