import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ServicesEnum } from '~/shared/constants/services.constant';
import {
  MigrateCategory,
  MigrateComment,
  MigrateData,
  MigrateFriend,
  MigratePage,
  MigratePost,
  MigrateUser,
} from './migrate.interface';
import { transportReqToMicroservice } from '~/shared/microservice.transporter';
import {
  CategoryEvents,
  CommentsEvents,
  FriendsEvents,
  PageEvents,
  PostEvents,
  UserEvents,
} from '~/shared/constants/event.constant';
import { CategoryModel } from '~/apps/page-service/src/model/category.model';
import { CommentsModel } from '~/apps/comments-service/src/comments.model';
import { PostModel } from '~/apps/page-service/src/model/post.model';
import { isValidObjectId } from 'mongoose';

@Injectable()
export class MigrateService {
  constructor(
    @Inject(ServicesEnum.page) private readonly pageService: ClientProxy,
    @Inject(ServicesEnum.user) private readonly userService: ClientProxy,
    @Inject(ServicesEnum.friends) private readonly friendsService: ClientProxy,
    @Inject(ServicesEnum.comments)
    private readonly commentsService: ClientProxy,
  ) {}

  async importUser(data: MigrateUser) {
    const exist = await transportReqToMicroservice(
      this.userService,
      UserEvents.UserGetMaster,
      {},
    ).catch((e) => {
      if (e?.status == 404) {
        return false;
      }
    });
    // if not exist, register
    if (!exist) {
      return await transportReqToMicroservice(
        this.userService,
        UserEvents.UserRegister,
        data,
      );
    } else {
      return await transportReqToMicroservice(
        this.userService,
        UserEvents.UserPatch,
        data,
      );
    }
  }

  async importFriends(data: MigrateFriend[]) {
    for (const friend of data) {
      await transportReqToMicroservice(
        this.friendsService,
        FriendsEvents.FriendCreate,
        {
          data: friend,
          isMaster: true, // prevent status change
        },
      );
    }
    return await transportReqToMicroservice(
      this.friendsService,
      FriendsEvents.FriendsGetAllByMaster,
      {
        all: true,
      },
    );
  }

  async importPages(data: MigratePage[]) {
    for (const page of data) {
      await transportReqToMicroservice(
        this.pageService,
        PageEvents.PageCreate,
        page,
      ).catch(() => {
        Logger.warn(`${page.title} 无法导入`, MigrateService.name);
        return null;
      })
    }
    return await transportReqToMicroservice(
      this.pageService,
      PageEvents.PagesGetAll,
      {},
    );
  }
  async importCategories(data: MigrateCategory[]) {
    for (const category of data) {
      const exist = await transportReqToMicroservice<CategoryModel[]>(
        this.pageService,
        CategoryEvents.CategoryGet,
        {
          _query: category.slug,
        },
      );
      if (exist) {
        continue;
      }
      await transportReqToMicroservice<CategoryModel>(
        this.pageService,
        CategoryEvents.CategoryCreate,
        category,
      );
    }
    return await transportReqToMicroservice<CategoryModel[]>(
      this.pageService,
      CategoryEvents.CategoryGetAll,
      {},
    );
  }

  async importPosts(data: MigratePost[], categoriesData: CategoryModel[]) {
    for (const post of data) {
      // transform category slug to id
      const category = isValidObjectId(post.category_id)
        ? categoriesData.find((c) => c.id == post.category_id)
        : categoriesData.find((c) => c.slug == post.category_id);
      let categoryId = category?.id;

      if (!categoryId) {
        // if not exist, create
        const create = await transportReqToMicroservice<CategoryModel>(
          this.pageService,
          CategoryEvents.CategoryCreate,
          {
            name: post.category_id,
            slug: post.category_id,
          },
        );
        categoryId = create.id;
      }
      await transportReqToMicroservice(
        this.pageService,
        PostEvents.PostCreate,
        {
          ...post,
          categoryId,
          category: undefined,
        },
      ).catch((e) => {
        Logger.warn(`${post.title} 无法导入`, MigrateService.name);
        return null;
      });
    }
    return await transportReqToMicroservice(
      this.pageService,
      PostEvents.PostsListGetAll,
      {},
    );
  }

  async importComments(data: MigrateComment[]) {
    // 1. Transform pid to post ObjectId,
    // if post not exist, skip, but put it into an array, finally return error report
    // 2. Sort comments, import parent comments first, then import children comments (Mog will auto bind parent comment)
    const postMap = new Map<string, string>();
    const postError = new Map<string, string>();
    const parentMap = new Map<string, string>();
    const parentError = new Map<string, string>();

    // 1. Transform pid to post ObjectId
    const posts = await transportReqToMicroservice(
      this.pageService,
      PostEvents.PostsListGetAll,
      {},
    );

    for (const post of posts) {
      postMap.set(post.id, post.id);
    }
    const _comments = data.map((comment) => {
      const postId = postMap.get(comment.pid);
      if (!postId) {
        postError.set(comment.pid, comment.pid);
        return null;
      }
      return {
        ...comment,
        pid: postId,
      };
    });

    const comments = _comments.filter((comment) => comment) as MigrateComment[]; // filter null
    async function sortAndImportComments(
      comments: MigrateComment[],
      commentsService: ClientProxy,
    ) {
      const parentComments = comments.filter((comment) => comment.children);
      const childrenComments = comments.filter((comment) => comment.parent);

      for (const comment of parentComments) {
        await transportReqToMicroservice(
          commentsService,
          CommentsEvents.CommentCreate,
          {
            data: {
              ...comment,
              id: undefined, // 重置 id，让 mog 自动生成
            },
            master: true,
          },
        );
      }

      // 2.1 Transform pid to parent comment ObjectId
      const parentCommentsData = await transportReqToMicroservice<
        CommentsModel[]
      >(commentsService, CommentsEvents.CommentsGetAll, {});
      for (const comment of parentCommentsData) {
        parentMap.set(comment.parent?.id, comment.id!); // parent comment id => comment id
      }

      // 2.2 Import children comments
      for (const comment of childrenComments) {
        const parentId = parentMap.get(comment.parent);
        if (!parentId) {
          parentError.set(comment.parent, comment.parent);
          continue;
        }
        await transportReqToMicroservice(
          commentsService,
          CommentsEvents.CommentCreate,
          {
            ...comment,
            id: undefined, // reset id, let mog auto generate
            parent: parentId,
          },
        );
        // Recursively sort and import child comments
        if (comment.children) {
          // the type of comment between MigrationComment and CommentsModel is different
          await sortAndImportComments(comment.children as any, commentsService);
        }
      }
    }

    // 2. Sort comments, and import
    await sortAndImportComments(comments, this.commentsService);

    // 3. Return error report
    return {
      postError: Array.from(postError.values()),
      parentError: Array.from(parentError.values()),
    };
  }

  async import(data: MigrateData) {
    const { user, friends, pages, categories, posts, comments } = data;
    const categoriesData = await this.importCategories(categories);
    const postsData = await this.importPosts(posts, categoriesData);
    const commentsData = await this.importComments(comments);
    return {
      user: await this.importUser(user),
      friends: await this.importFriends(friends),
      pages: await this.importPages(pages),
      categories: categoriesData,
      posts: postsData,
      comments: commentsData,
    };
  }

  async exportUser() {
    return await transportReqToMicroservice(
      this.userService,
      UserEvents.UserGetMaster,
      {},
    );
  }

  async exportFriends() {
    return await transportReqToMicroservice(
      this.friendsService,
      FriendsEvents.FriendsGetAllByMaster,
      {
        all: true,
      },
    );
  }

  async exportPages() {
    return await transportReqToMicroservice(
      this.pageService,
      PageEvents.PagesGetAll,
      {},
    );
  }

  async exportCategories() {
    return await transportReqToMicroservice<CategoryModel[]>(
      this.pageService,
      CategoryEvents.CategoryGetAll,
      {},
    );
  }

  async exportPosts() {
    const posts = await transportReqToMicroservice<PostModel[]>(
      this.pageService,
      PostEvents.PostsListGetAll,
      {},
    );

    // 把 category 和 categoryId 都转成 slug
    const categories = await transportReqToMicroservice<CategoryModel[]>(
      this.pageService,
      CategoryEvents.CategoryGetAll,
      {},
    );
    const categoriesMap = new Map<string, string>();
    for (const category of categories) {
      categoriesMap.set(category.id!, category.slug);
    }
    const data = posts.map((post) => {
      const category = post.category;
      return {
        ...post,
        category: categoriesMap.get(category?.id),
        categoryId: categoriesMap.get(post.categoryId as any),
      };
    });
    return data;
  }

  async exportComments() {
    const req = await transportReqToMicroservice<CommentsModel[]>(
      this.commentsService,
      CommentsEvents.CommentsGetAll,
      {},
    );
    // 把 parent 和 children 都转成 id
    const data = req.map((comment) => {
      const parent = comment.parent;
      const children = comment.children;
      return {
        ...comment,
        parent: parent?.id,
        children: children?.map((child) => child.id),
      };
    });
    return data;
  }

  async export() {
    const user = await this.exportUser();
    const friends = await this.exportFriends();
    const pages = await this.exportPages();
    const categories = await this.exportCategories();
    const posts = await this.exportPosts();
    const comments = await this.exportComments();
    return {
      user,
      friends,
      pages,
      categories,
      posts,
      comments,
    };
  }
}
